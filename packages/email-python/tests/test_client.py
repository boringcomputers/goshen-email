import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from bezalel_email import BezalelEmail, BezalelError


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        records = self.requests
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                records.append((self.path, self.headers.get("Authorization"), None))
                if self.path == "/v1/inboxes":
                    self.send_response(200); self.end_headers(); self.wfile.write(b'{"inboxes":[]}')
                else:
                    self.send_response(307); self.send_header("Location", "/other"); self.end_headers()
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                records.append((self.path, self.headers.get("Authorization"), body))
                self.send_response(422); self.end_headers(); self.wfile.write(b'{"error":{"code":"send_uncertain","message":"Retry same key","transient":false}}')
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.client = BezalelEmail("bze_test", f"http://127.0.0.1:{self.server.server_port}")

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def test_list(self):
        self.assertEqual(self.client.inboxes.list(), {"inboxes": []})
        self.assertEqual(self.requests[0][1], "Bearer bze_test")

    def test_send_maps_snake_case_and_never_retries(self):
        with self.assertRaises(BezalelError) as raised:
            self.client.messages.send(inbox_id="me@example.com", to=["you@example.net"], text="hello", idempotency_key="stable")
        self.assertEqual(raised.exception.code, "send_uncertain")
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0][2]["idempotencyKey"], "stable")
        self.assertNotIn("inboxId", self.requests[0][2])

    def test_redirect_is_not_followed(self):
        with self.assertRaises(BezalelError): self.client.inboxes.get(inbox_id="me@example.com")
        self.assertEqual(len(self.requests), 1)

    def test_missing_key_and_unsafe_origin(self):
        with self.assertRaises(ValueError): BezalelEmail("platform_key")
        with self.assertRaises(ValueError): BezalelEmail("bze_test", "http://external.example")
        with self.assertRaises(ValueError): self.client.messages.send(inbox_id="me@example.com", text="x")
        self.assertEqual(self.requests, [])

    def test_pagination(self):
        seen = []
        def request(operation, parameters):
            seen.append(dict(parameters))
            return {"messages": [], **({"nextPageToken": "2"} if len(seen) == 1 else {})}
        self.client.request = request
        self.assertEqual(len(list(self.client.pages("listMessages", inbox_id="me@example.com", limit=1))), 2)
        self.assertEqual(seen[1]["pageToken"], "2")


if __name__ == "__main__": unittest.main()
