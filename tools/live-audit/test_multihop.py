"""Deterministic traversal and SSRF tests. No network or browser dependency."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from documents import Bounds, collect, approved, public_addresses, download
from pipeline_bridge import save


class MultihopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        path = self.root / 'data/maps/hospitals.geojson'
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'features': [{'id': '362', 'properties': {'assistance_url': 'https://example.org/financial-assistance'}}]}))
        self.calls = []
        self.web = {
            '/financial-assistance': b'<a href="/resources">Financial assistance resources</a>',
            '/resources': b'<a href="/documents/">Documents</a><a href="/financial-assistance">Financial assistance</a>',
            '/documents/': b'<a href="/en.pdf">English</a><a href="/es.pdf">Spanish</a><a href="/en.pdf#page=1">Duplicate</a>',
            '/en.pdf': b'%PDF-SYN English', '/es.pdf': b'%PDF-SYN Spanish'}

    def fetch(self, url, host):
        from urllib.parse import urlsplit
        self.calls.append(url)
        path = urlsplit(url).path
        value = self.web.get(path)
        if value is None:
            raise HTTPError(url, 404, 'SYN unavailable', None, None)
        if isinstance(value, tuple):
            return value
        return value, url, 'application/pdf' if path.endswith('.pdf') else 'text/html'

    def run_collection(self, **limits):
        return collect('362', self.root, self.root / 'out', save, self.fetch, Bounds(**limits))['output']

    def test_three_hops_cycles_duplicates_languages_and_identical_recollection(self):
        result = self.run_collection()
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(len(result['pages']), 3)
        self.assertEqual(len(result['documents']), 2)
        self.assertEqual(result['documents'][0]['labels'], ['English', 'Duplicate'])
        self.assertEqual(result['documents'][1]['labels'], ['Spanish'])
        self.assertEqual(len(set(self.calls)), len(self.calls))
        before = [d['sha256'] for d in result['documents']]
        again = self.run_collection()
        self.assertEqual(before, [d['sha256'] for d in again['documents']])
        self.assertTrue(all(e['parent_sha256'] for e in result['links']))
        self.assertEqual(len(list((self.root / 'out/collections/362').glob('*.json'))), 2)

    def test_two_hops_and_depth_limit(self):
        self.web['/resources'] = b'<a href="/en.pdf">English assistance</a>'
        self.assertEqual(self.run_collection(depth=2)['documents'][0]['status'], 'saved')
        shallow = self.run_collection(depth=1)
        self.assertEqual(shallow['status'], 'partial')
        self.assertEqual(shallow['documents'][0]['status'], 'failed')

    def test_broken_child_and_javascript_are_gaps_not_absence(self):
        self.web['/financial-assistance'] += b'<script>SYN no execution</script><a href="/missing">Financial help</a>'
        result = self.run_collection()
        self.assertEqual(result['status'], 'partial')
        self.assertIn('Scripts not executed', result['pages'][0]['discovery_gap'])
        self.assertEqual(result['pages'][2]['http_status'], 404)
        self.assertEqual(result['pages'][2]['availability'], 'inaccessible')

    def test_redirected_document_preserves_identity_and_rejects_untrusted_final_host(self):
        self.web['/en.pdf'] = (b'%PDF-SYN moved', 'https://www.example.org/new.pdf', 'application/pdf')
        result = self.run_collection()
        doc = result['documents'][0]
        self.assertEqual(doc['source_url'], 'https://example.org/en.pdf')
        self.assertEqual(doc['final_url'], 'https://www.example.org/new.pdf')
        self.assertEqual(doc['sha256'], hashlib.sha256(b'%PDF-SYN moved').hexdigest())
        self.web['/en.pdf'] = (b'%PDF-SYN moved', 'https://outside.example/new.pdf', 'application/pdf')
        self.assertEqual(self.run_collection()['documents'][0]['status'], 'failed')

    def test_ssrf_policy_and_dns_rebinding_defense(self):
        for url, host in [('https://127.0.0.1/x', '127.0.0.1'), ('https://[::1]/x', '::1'),
                          ('https://169.254.169.254/x', '169.254.169.254'), ('file:///etc/passwd', ''),
                          ('https://localhost/x', 'localhost'), ('https://example.org:444/a', 'example.org'),
                          ('https://user@example.org/a', 'example.org'), ('https://example.org\\@evil.test/a', 'example.org')]:
            with self.assertRaises(ValueError):
                approved(url, host)
        for addresses in [['127.0.0.1'], ['8.8.8.8', '10.0.0.1'], ['::ffff:127.0.0.1'], ['224.0.0.1']]:
            with patch('documents.socket.getaddrinfo', return_value=[(2, 1, 6, '', (a, 443)) for a in addresses]):
                with self.assertRaises(ValueError):
                    public_addresses('example.org')

    def test_external_links_not_fetched_and_limits_are_explicit(self):
        self.web['/financial-assistance'] += b'<a href="https://other.example/x.pdf">External</a>'
        result = self.run_collection(pages=1)
        self.assertEqual(result['status'], 'partial')
        self.assertFalse(any('other.example' in c for c in self.calls))
        self.assertTrue(any('outside' in d.get('reason', '') for d in result['documents']))
        self.assertEqual(self.run_collection(bytes_per_resource=10)['status'], 'failed')
        with self.assertRaises(ValueError):
            Bounds(pages=101)
        self.web['/financial-assistance'] = b'<base href="https://outside.example/"><a href="form.pdf">Financial assistance</a>'
        based = self.run_collection()
        self.assertEqual(based['documents'][0]['source_url'], 'https://outside.example/form.pdf')
        self.assertEqual(based['documents'][0]['status'], 'failed')

    def test_campus_classification_requires_pinned_content_not_link_label(self):
        path = self.root / 'docs/audit-format/wave-one-document-inventory.json'
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'hospitals': [{'hospital_key': '999', 'documents': [
            {'status': 'content_confirmed', 'sha256': hashlib.sha256(self.web['/en.pdf']).hexdigest(), 'type': 'application', 'language_label': 'English'}]}]}))
        doc = self.run_collection()['documents'][0]
        self.assertEqual(doc['classification'], 'other_campus_requires_review')
        self.assertNotIn('document_type', doc)

    def test_tls_connects_to_validated_ip_with_original_hostname_and_bounds_redirects(self):
        import io
        from collections import Counter
        from usage import usage
        counters = Counter()
        self.addCleanup(usage.reset, usage.set(counters))
        from email.message import Message
        from unittest.mock import MagicMock
        response = MagicMock()
        response.status = 200
        response.headers = Message()
        response.headers['Content-Type'] = 'application/pdf'
        response.read1.side_effect = io.BytesIO(b'%PDF-SYN pinned').read1
        connection = MagicMock()
        connection.getresponse.return_value = response
        with patch('documents.public_addresses', return_value=['8.8.8.8']), \
                patch('documents.socket.create_connection') as connect, \
                patch('documents.ssl.create_default_context') as tls, \
                patch('documents.http.client.HTTPSConnection', return_value=connection):
            data, url, mime = download('https://example.org/a.pdf', 'example.org')
            self.assertEqual(data, b'%PDF-SYN pinned')
            self.assertEqual(connect.call_args.args[0], ('8.8.8.8', 443))
            self.assertEqual(tls.return_value.wrap_socket.call_args.kwargs['server_hostname'], 'example.org')
            response.status = 302
            response.getheader.return_value = 'https://127.0.0.1/private'
            with self.assertRaises(ValueError):
                download('https://example.org/a.pdf', 'example.org')
            response.getheader.return_value = '/a.pdf'
            with self.assertRaisesRegex(ValueError, 'Redirect limit'):
                download('https://example.org/a.pdf', 'example.org', Bounds(redirects=1))
            self.assertEqual(counters, {'network_requests': 4, 'network_bytes': len(data)})

    def test_little_falls_original_html_discovers_both_campus_confirmed_summaries(self):
        import zipfile
        repo = Path(__file__).resolve().parents[2]
        with zipfile.ZipFile(repo / 'docs/validation/pilot-wave-one-evidence.zip') as archive:
            bundle = json.loads(archive.read('assessments/362.json'))
            sources = {s['source_id']: s['snapshot'] for s in bundle['input']['sources'] if s['snapshot']}

            def saved_fetch(url, host):
                if url not in sources:
                    raise HTTPError(url, 404, 'Not in saved capture set', None, None)
                s = sources[url]
                suffix = Path(s['artifact_path']).suffix
                return archive.read(s['artifact_path']), url, 'text/html' if suffix == '.html' else 'application/octet-stream'

            result = collect('362', repo, self.root / 'out', save, saved_fetch)['output']
            summaries = [d for d in result['documents'] if d.get('document_type') == 'policy_summary']
            self.assertEqual(len(summaries), 2)
            self.assertEqual({d['language'] for d in summaries}, {'English', 'Spanish'})
            self.assertEqual({d['depth'] for d in summaries}, {2})
            for d in summaries:
                self.assertEqual(d['classification'], 'pinned_campus_inventory')
                self.assertTrue(any(e['target_url'] == d['source_url'] and e['parent_url'] == d['parent_url'] for e in result['links']))
                self.assertEqual(hashlib.sha256((self.root / 'out' / d['artifact_path']).read_bytes()).hexdigest(), d['sha256'])


if __name__ == '__main__':
    unittest.main()
