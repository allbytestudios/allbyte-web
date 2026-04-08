"""Unit test for the OAuth secret parser used in Lambda functions."""


def parse_oauth_secret(raw):
    """Parse OAuth secret in format: {client_id:xxx,client_secret:xxx}"""
    raw = raw.strip().strip("{}")
    parts = {}
    for pair in raw.split(","):
        key, _, value = pair.partition(":")
        parts[key.strip()] = value.strip()
    return {"client_id": parts["client_id"], "client_secret": parts["client_secret"]}


def test_simple_format():
    raw = "{client_id:abc123,client_secret:def456}"
    result = parse_oauth_secret(raw)
    assert result == {"client_id": "abc123", "client_secret": "def456"}


def test_with_spaces():
    raw = "{ client_id: abc123, client_secret: def456 }"
    result = parse_oauth_secret(raw)
    assert result == {"client_id": "abc123", "client_secret": "def456"}


def test_long_values():
    raw = "{client_id:123456789012-abcdefg.apps.googleusercontent.com,client_secret:GOCSPX-abcdef123456}"
    result = parse_oauth_secret(raw)
    assert result["client_id"] == "123456789012-abcdefg.apps.googleusercontent.com"
    assert result["client_secret"] == "GOCSPX-abcdef123456"


if __name__ == "__main__":
    test_simple_format()
    test_with_spaces()
    test_long_values()
    print("All tests passed!")
