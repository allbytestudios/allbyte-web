#!/usr/bin/env python3
"""Generate the datacenter /16 prefix set used by the Site Traffic bot filter.

Fetches the published IPv4 ranges for AWS, GCP, and Azure, collapses them to
distinct /16 prefixes ("A.B"), and uploads the set to
s3://allbyte-studio-cfn-deploy/traffic-config/datacenter-16s.json.

The Site Traffic Lambda (allbyte-studio-site-traffic) reads that file and
flags any request whose IP's first two octets fall in the set as a bot. This
replaces the old hand-maintained DATACENTER_IP_PREFIXES list — no more adding
Azure /16s one at a time as the swarm rotates ranges.

Refresh: just re-run this (`python scripts/gen-datacenter-ranges.py`). The
cloud ranges change slowly, so monthly/quarterly is plenty. Safe to run any
time — it overwrites the S3 object atomically and the Lambda picks it up on
its next cache-miss.

Requires: boto3 + AWS creds with s3:PutObject on allbyte-studio-cfn-deploy.
"""
import io
import json
import re
import sys
import urllib.request
import ipaddress
import boto3

BUCKET = "allbyte-studio-cfn-deploy"
KEY = "traffic-config/datacenter-16s.json"

AWS_URL = "https://ip-ranges.amazonaws.com/ip-ranges.json"
GCP_URL = "https://www.gstatic.com/ipranges/cloud.json"
AZURE_PAGE = "https://www.microsoft.com/en-us/download/details.aspx?id=56519"


def _get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "allbyte-dc-ranges/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def aws_cidrs():
    d = json.loads(_get(AWS_URL))
    return [p["ip_prefix"] for p in d.get("prefixes", [])]


def gcp_cidrs():
    d = json.loads(_get(GCP_URL))
    return [p["ipv4Prefix"] for p in d.get("prefixes", []) if "ipv4Prefix" in p]


def azure_cidrs():
    # The ServiceTags download URL rotates weekly; resolve it from the page.
    page = _get(AZURE_PAGE).decode("utf-8", "replace")
    m = re.search(
        r"https://download\.microsoft\.com/download/[^\"']*ServiceTags_Public_\d+\.json",
        page,
    )
    if not m:
        raise RuntimeError("could not resolve Azure ServiceTags URL from download page")
    d = json.loads(_get(m.group(0)))
    out = []
    for v in d.get("values", []):
        out += v.get("properties", {}).get("addressPrefixes", [])
    return out


def to_16s(cidrs):
    """Collapse a list of CIDRs to the set of covering /16 prefixes ('A.B')."""
    s = set()
    for c in cidrs:
        try:
            net = ipaddress.ip_network(c, strict=False)
        except ValueError:
            continue
        if net.version != 4:
            continue
        if net.prefixlen >= 16:
            o = str(net.network_address).split(".")
            s.add(f"{o[0]}.{o[1]}")
        else:
            for sub in net.subnets(new_prefix=16):
                o = str(sub.network_address).split(".")
                s.add(f"{o[0]}.{o[1]}")
    return s


def main():
    parts = {}
    for name, fn in (("aws", aws_cidrs), ("gcp", gcp_cidrs), ("azure", azure_cidrs)):
        try:
            cidrs = fn()
            parts[name] = to_16s(cidrs)
            print(f"{name}: {len(cidrs)} cidrs -> {len(parts[name])} /16 blocks")
        except Exception as e:
            print(f"WARNING: {name} fetch failed: {e}", file=sys.stderr)
            parts[name] = set()
    union = set().union(*parts.values())
    if len(union) < 1000:
        # Safety: a good run yields ~2800. Refuse to publish a suspiciously
        # small set that would blind the bot filter.
        print(f"ABORT: only {len(union)} /16 blocks — refusing to publish", file=sys.stderr)
        sys.exit(1)
    payload = {
        "count": len(union),
        "sources": {k: len(v) for k, v in parts.items()},
        "prefixes16": sorted(union),
    }
    body = json.dumps(payload).encode("utf-8")
    boto3.client("s3").put_object(
        Bucket=BUCKET, Key=KEY, Body=body, ContentType="application/json"
    )
    print(f"uploaded {len(union)} /16 blocks ({len(body)} bytes) to s3://{BUCKET}/{KEY}")


if __name__ == "__main__":
    main()
