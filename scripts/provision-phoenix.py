import json
import os
import secrets
from pathlib import Path
import argparse
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener


parser = argparse.ArgumentParser(description="Provision private Phoenix collector and Viewer keys")
parser.add_argument("--url", default="http://127.0.0.1:6006")
parser.add_argument("--output-dir", required=True)
args = parser.parse_args()
root = Path(args.output_dir)
base = args.url.rstrip("/")
admin_secret = os.environ["PHOENIX_ADMIN_SECRET"]
root.mkdir(mode=0o700, parents=True, exist_ok=True)
if (root / "phoenix-keys.json").exists() or (root / "phoenix-viewer.env").exists():
    raise SystemExit("Output keys already exist; use the existing keys or revoke them before provisioning new ones")


def call(opener, path, payload, authorization=None):
    data = json.dumps(payload).encode()
    headers = {"content-type": "application/json"}
    if authorization:
        headers["authorization"] = f"Bearer {authorization}"
    request = Request(base + path, data=data, headers=headers, method="POST")
    try:
        with opener.open(request) as response:
            body = response.read()
            return response.status, json.loads(body) if body else None
    except HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"{path} returned {error.code}: {detail}") from error


opener = build_opener(HTTPCookieProcessor())
status, policy = call(opener, "/graphql", {"query": "{ defaultProjectTraceRetentionPolicy { id } }"}, admin_secret)
if status != 200 or policy.get("errors"):
    raise RuntimeError("Unable to read default retention policy")
status, updated = call(opener, "/graphql", {
    "query": "mutation($input: PatchProjectTraceRetentionPolicyInput!) { patchProjectTraceRetentionPolicy(input:$input) { node { cronExpression rule { ... on TraceRetentionRuleMaxDays { maxDays } } } } }",
    "variables": {"input": {"id": policy["data"]["defaultProjectTraceRetentionPolicy"]["id"], "cronExpression": "0 * * * *", "rule": {"maxDays": {"maxDays": 7}}}},
}, admin_secret)
if status != 200 or updated.get("errors"):
    raise RuntimeError("Unable to configure seven-day retention with an hourly sweep")
status, system_response = call(
    opener,
    "/v1/system/api_keys",
    {"data": {"name": "phoenix-validation-collector"}},
    admin_secret,
)
assert status == 201

suffix = secrets.token_hex(5)
email = f"viewer-{suffix}@example.invalid"
password = "V4!" + secrets.token_urlsafe(30)
status, _ = call(
    opener,
    "/v1/users",
    {
        "user": {
            "email": email,
            "username": f"viewer-{suffix}",
            "role": "VIEWER",
            "auth_method": "LOCAL",
            "password": password,
        },
        "send_welcome_email": False,
    },
    admin_secret,
)
assert status == 201
status, _ = call(opener, "/auth/login", {"email": email, "password": password})
assert status == 204
new_password = "V5!" + secrets.token_urlsafe(30)
status, changed = call(opener, "/graphql", {"query": "mutation($input: PatchViewerInput!){ patchViewer(input:$input){ user { id } } }", "variables": {"input": {"currentPassword": password, "newPassword": new_password}}})
assert status == 200 and not changed.get("errors"), "Viewer initial password reset failed"
status, _ = call(opener, "/auth/login", {"email": email, "password": new_password})
assert status == 204
status, viewer_response = call(
    opener,
    "/v1/user/api_keys",
    {"data": {"name": "phoenix-validation-viewer"}},
)
assert status == 201

secret_path = root / "phoenix-keys.json"
fd = os.open(secret_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    json.dump(
        {
            "systemKey": system_response["data"]["key"],
            "systemKeyId": system_response["data"]["id"],
            "viewerKey": viewer_response["data"]["key"],
            "viewerKeyId": viewer_response["data"]["id"],
        },
        stream,
    )
fd = os.open(root / "phoenix-viewer.env", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    stream.write("PHOENIX_VIEWER_KEY=" + viewer_response["data"]["key"] + "\n")
print("Created collector and Viewer keys in the private output directory (mode 0600).")
