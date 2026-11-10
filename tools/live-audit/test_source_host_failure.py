"""Synthetic collector failures must retain the safe non-retryable diagnostic."""
import unittest
from pathlib import Path
from unittest.mock import patch
from pipeline_bridge import run


class SourceHostFailureTest(unittest.TestCase):
    def test_http_403_carries_sanitized_source_and_manifest(self):
        from pipeline_bridge import CollectionFailure
        url = 'https://hospital.example/aid?token=SYN-PRIVATE#part'
        output = {"status": "failed", "landing_url": url, "pages": [{"source_url": url, "http_status": 403}]}
        with patch('pipeline_bridge.collect', return_value={"output": output, "manifest_file": '/local/collections/' + 'a'*32 + '.json'}):
            with self.assertRaises(CollectionFailure) as caught:
                run(Path('.'), {"mode": "live", "hospital_key": "798"})
        self.assertEqual(caught.exception.code, 'http_error')
        self.assertEqual(caught.exception.diagnostic, {"http_status": 403, "source_url": 'https://hospital.example/aid', "manifest_id": 'a'*32})
    def test_tls_failure_retains_safe_code(self):
        output = {"status": "failed", "pages": [{"error_code": "tls_certificate_invalid"}]}
        with patch("pipeline_bridge.collect", return_value={"output": output}):
            with self.assertRaisesRegex(ValueError, '^tls_certificate_invalid$'):
                run(Path('.'), {"mode": "live", "hospital_key": "303"})

    def test_blocked_landing_has_specific_code(self):
        output = {"status": "failed", "pages": [{"error_code": "source_host_blocked"}]}
        with patch("pipeline_bridge.collect", return_value={"output": output}):
            with self.assertRaisesRegex(ValueError, '^source_host_blocked$'):
                run(Path('.'), {"mode": "live", "hospital_key": "303"})

    def test_other_failure_does_not_get_host_code(self):
        with patch("pipeline_bridge.collect", return_value={"output": {"status": "failed", "pages": [{"reason": "synthetic timeout"}]}}):
            with self.assertRaisesRegex(ValueError, '^collection_failed$'):
                run(Path('.'), {"mode": "live", "hospital_key": "303"})
