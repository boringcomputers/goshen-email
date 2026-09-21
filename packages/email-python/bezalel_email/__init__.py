"""Goshen Email client. Retries never happen implicitly."""
import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from importlib.resources import files
from typing import Any, Iterator

_MANIFEST = json.loads(files(__package__).joinpath("manifest.json").read_text())
DEFAULT_BASE_URL = "https://bezalel-email-standalone.michaelwasihun96.workers.dev"


class BezalelError(Exception):
    def __init__(self, message: str, status: int = 0, code: str = "api_error", transient: bool = False):
        super().__init__(message)
        self.status, self.code, self.transient = status, code, transient


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _wire(value: Any) -> Any:
    if isinstance(value, dict):
        return {re.sub(r"_([a-z])", lambda m: m[1].upper(), key): _wire(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_wire(item) for item in value]
    return value


class _Resource:
    def __init__(self, client, methods):
        self._client, self._methods = client, methods

    def __getattr__(self, name):
        if name not in self._methods:
            raise AttributeError(name)
        operation = self._methods[name]
        return lambda **parameters: self._client.request(operation, parameters)


class BezalelEmail:
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL, timeout: float = 30):
        if not re.fullmatch(r"(?:bze_|gme_)\S+", api_key or ""):
            raise ValueError("Use an account API key (bze_) or mailbox key (gme_)")
        url = urllib.parse.urlsplit(base_url)
        if (url.username or url.password or url.query or url.fragment or url.path not in ("", "/") or not url.hostname or
                (url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")))):
            raise ValueError("base_url must be an HTTPS origin (HTTP is allowed only on loopback)")
        if not 0 < timeout <= 300:
            raise ValueError("timeout must be between 0 and 300 seconds")
        self._key, self._base, self._timeout = api_key, base_url.rstrip("/"), timeout
        self._opener = urllib.request.build_opener(_NoRedirect())
        self.inboxes = _Resource(self, {"list": "listInboxes", "create": "createInbox", "get": "getInbox", "update": "updateInbox", "delete": "deleteInbox", "finish_setup": "finishInboxSetup"})
        self.messages = _Resource(self, {"list": "listMessages", "search": "searchMessages", "get": "getMessage", "send": "send", "reply": "reply", "update_labels": "updateMessageLabels", "get_attachment": "getAttachment"})
        self.threads = _Resource(self, {"list": "listThreads", "get": "getThread", "update_labels": "updateThreadLabels"})
        self.account = _Resource(self, {"usage": "getUsage"})

    def request(self, operation: str, parameters: dict[str, Any] | None = None) -> Any:
        if operation not in _MANIFEST:
            raise ValueError("Unknown email operation")
        definition = _MANIFEST[operation]
        data = _wire(parameters or {})
        properties = definition["inputSchema"]["properties"]
        if set(data) - set(properties):
            raise ValueError("Unknown operation parameter")
        if set(definition["inputSchema"].get("required", [])) - set(data):
            raise ValueError("Missing required operation parameter")
        def path_value(match):
            value = data.pop(match[1])
            if not isinstance(value, str) or not value:
                raise ValueError("Path identifiers must be nonempty strings")
            return urllib.parse.quote(value, safe="")
        path = re.sub(r"\{(\w+)\}", path_value, definition["path"])
        url = self._base + path
        body = None
        if definition["method"] == "GET":
            query = [(key, str(item).lower() if isinstance(item, bool) else item) for key, value in data.items() if value is not None
                     for item in (value if isinstance(value, list) else [value])]
            if query:
                url += "?" + urllib.parse.urlencode(query)
        elif definition["method"] != "DELETE":
            body = json.dumps(data).encode()
        request = urllib.request.Request(url, data=body, method=definition["method"], headers={
            "Authorization": "Bearer " + self._key, "Content-Type": "application/json", "Accept": "application/json",
            "User-Agent": "bezalel-email-python"})
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            try:
                detail = json.load(error).get("error", {})
            except (ValueError, AttributeError):
                detail = {}
            finally:
                error.close()
            if not isinstance(detail, dict):
                detail = {}
            message = detail.get("message") if isinstance(detail.get("message"), str) else "Email request failed"
            raise BezalelError(message.replace(self._key, "[redacted]"), error.code, detail.get("code", "api_error"), detail.get("transient") is True) from None
        except (urllib.error.URLError, TimeoutError, socket.timeout):
            raise BezalelError("Request did not complete. Retry a send with the same idempotency_key and contents.", code="network_error", transient=True) from None
        except ValueError:
            raise BezalelError("The API returned an unreadable response", code="invalid_response") from None

    def pages(self, operation: str, **parameters: Any) -> Iterator[dict[str, Any]]:
        if operation not in ("listInboxes", "listMessages", "searchMessages", "listThreads"):
            raise ValueError("This operation does not support pagination")
        data = _wire(parameters)
        seen = set()
        while True:
            token = data.get("pageToken")
            if token in seen:
                raise BezalelError("API repeated a pagination cursor", code="invalid_response")
            seen.add(token)
            page = self.request(operation, data)
            yield page
            token = page.get("nextPageToken")
            if not token:
                return
            data["pageToken"] = token
