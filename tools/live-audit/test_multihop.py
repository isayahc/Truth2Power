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
    def test_cloudflare_challenge_requires_human_not_every_403(self):
        from email.message import Message
        headers=Message();headers['Cf-Mitigated']='challenge'
        def blocked(url,host):
            raise HTTPError(url,403,'Forbidden',headers,None)
        result=collect('362',self.root,self.root/'out',save,blocked)['output']
        self.assertEqual(result['pages'][0]['error_code'],'website_verification_required')
        del headers['Cf-Mitigated']
        result=collect('362',self.root,self.root/'out',save,blocked)['output']
        self.assertNotIn('error_code',result['pages'][0])
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
        self.assertEqual(shallow['documents'][0]['limit'], 'depth')

    def test_financial_aid_sources_take_precedence_on_a_mixed_documents_page(self) -> None:
        """Capture both applications, the notice and guidelines within four slots."""
        other_files = ['/financial-assistance/board.pdf', '/transportation.pdf', '/volunteer.pdf']
        applications = [
            ('/NOTICE-OF-FINANCIAL-AID.pdf', 'Notice'),
            ('https://files.example/01', 'Financial assistance application'),
            ('/descarga.pdf', 'Solicitud de ayuda financiera'),
            ('/FA_Guidelines.pdf', 'Read guidelines'),
        ]
        self.web['/financial-assistance'] = (
            ''.join(f'<a href="{url}">Public records</a>' for url in other_files)
            + '<a href="/resources">Patient resources</a>'
        ).encode()
        self.web['/resources'] = ''.join(
            f'<a type="application/pdf" href="{url}">{label}</a>' for url, label in applications
        ).encode()
        for path in other_files + ['/NOTICE-OF-FINANCIAL-AID.pdf', '/descarga.pdf', '/FA_Guidelines.pdf']:
            self.web[path] = b'%PDF-SYN ' + path.encode()
        self.web['/01'] = (b'%PDF-SYN form', 'https://files.example/01', 'application/pdf')

        result = self.run_collection(documents=4)
        documents = result['documents']
        saved = [doc for doc in documents if doc['status'] == 'saved']
        self.assertEqual([doc['published_link']['anchor_label'] for doc in saved],
                         [label for _, label in applications])
        parent = result['pages'][1]
        self.assertTrue(all(doc['published_link']['parent_sha256'] == parent['sha256'] for doc in saved))
        self.assertTrue(all(doc['classification'] == 'unverified' for doc in saved))
        failed = [doc for doc in documents if doc['status'] == 'failed']
        self.assertEqual([doc['source_url'] for doc in failed], ['https://example.org' + p for p in other_files])
        self.assertTrue(all(doc['error_code'] == 'resource_limit' and doc['limit'] == 'documents' for doc in failed))
        self.assertEqual(len(self.calls), 6)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(self.run_collection()['status'], 'complete')

    def test_time_and_total_size_limits_remain_distinct(self) -> None:
        """The audit can distinguish an expired crawl from exhausted download capacity."""
        self.web['/financial-assistance'] = b'<a href="/en.pdf">Application</a>'
        with patch('documents.time.monotonic', side_effect=[0, 0, 1]):
            expired = self.run_collection(seconds=1)
        self.assertEqual(expired['documents'][0]['limit'], 'seconds')
        exhausted = self.run_collection(total_bytes=len(self.web['/financial-assistance']))
        self.assertEqual(exhausted['documents'][0]['limit'], 'total_bytes')

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

    def test_external_files_are_terminal_and_contacts_do_not_consume_budget(self) -> None:
        """File links may delegate retrieval, while external HTML and contact links never extend a crawl."""
        self.web['/financial-assistance'] = (
            b'<a href="https://files.example/get">Financial assistance application</a>'
            b'<a href="https://files.example/bad.pdf">PDF</a>'
            b'<a href="https://other.example/resources">Financial assistance resources</a>'
            b'<a href="mailto:aid@example.org">Application</a><a href="tel:5550000">Billing</a>')
        self.web['/get'] = (b'%PDF-SYN', 'https://files.example/get', 'application/octet-stream')
        self.web['/bad.pdf'] = b'<a href="/secret.pdf">PDF</a>'
        result = self.run_collection()
        good, bad = result['documents']
        self.assertEqual(good['status'], 'saved')
        self.assertEqual(good['published_link']['parent_sha256'], result['landing_page']['sha256'])
        self.assertEqual(good['published_link']['anchor_label'], 'Financial assistance application')
        self.assertEqual(bad['error_code'], 'invalid_document')
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(sum(e['disposition'] == 'non_retrieval' for e in result['links']), 2)
        self.assertEqual(self.run_collection(documents=1)['documents'][1]['error_code'], 'resource_limit')
        self.assertEqual(self.run_collection(bytes_per_resource=10)['status'], 'failed')
        with self.assertRaises(ValueError):
            Bounds(pages=101)

    def test_typed_extensionless_document_and_same_host_content_detection(self) -> None:
        """An explicit download anchor or a document response can identify a file without a suffix."""
        self.web['/financial-assistance'] = (
            b'<a type="application/pdf" href="https://files.example/id">English</a>'
            b'<a href="/resources">Resources</a>')
        self.web['/id'] = (b'%PDF-SYN typed', 'https://files.example/id', 'application/pdf')
        self.web['/resources'] = (b'%PDF-SYN local', 'https://example.org/resources', 'application/pdf')
        result = self.run_collection()
        self.assertEqual(len(result['pages']), 1)
        self.assertEqual([d['status'] for d in result['documents']], ['saved', 'saved'])
        self.assertTrue(all(d['artifact_path'].endswith('.pdf') for d in result['documents']))

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
            with self.assertRaisesRegex(ValueError, 'Redirect loop'):
                download('https://example.org/a.pdf', 'example.org', Bounds(redirects=1))
            self.assertEqual(counters, {'network_requests': 3, 'network_bytes': len(data)})

    def test_cross_host_redirect_is_pinned_and_traced_but_private_dns_is_blocked(self):
        import io
        from email.message import Message
        from unittest.mock import MagicMock
        first, final = MagicMock(), MagicMock()
        first.status = 301
        first.getheader.return_value = 'https://network.example/financial-assistance'
        final.status = 200
        final.headers = Message()
        final.headers['Content-Type'] = 'text/html'
        final.read1.side_effect = io.BytesIO(b'<html>SYN hospital network</html>').read1
        connection = MagicMock()
        connection.getresponse.side_effect = [first, final]
        trace = []
        with patch('documents.public_addresses', return_value=['8.8.8.8']) as dns, \
                patch('documents.socket.create_connection'), \
                patch('documents.ssl.create_default_context') as tls, \
                patch('documents.http.client.HTTPSConnection', return_value=connection):
            _, url, _ = download('https://example.org/old', 'example.org', trace=trace)
            self.assertEqual(url, 'https://network.example/financial-assistance')
            self.assertEqual([c.args[0] for c in dns.call_args_list], ['example.org', 'network.example'])
            self.assertEqual(tls.return_value.wrap_socket.call_args.kwargs['server_hostname'], 'network.example')
            self.assertEqual(trace, [dict(source_url='https://example.org/old', final_url=url, http_status=301)])
        connection.getresponse.side_effect = [first]
        with patch('documents.public_addresses', side_effect=[['8.8.8.8'], ValueError('DNS resolved to a non-public address')]), \
                patch('documents.socket.create_connection') as connect, \
                patch('documents.ssl.create_default_context'), \
                patch('documents.http.client.HTTPSConnection', return_value=connection):
            with self.assertRaisesRegex(ValueError, 'non-public'):
                download('https://example.org/old', 'example.org')
            self.assertEqual(connect.call_count, 1)

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
