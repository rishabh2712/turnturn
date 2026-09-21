import { ALLOWED_LINK_PROTOCOLS, WORKSPACE_FILE_PROTOCOL } from "./sanitize-schema";

// react-markdown applies its own `defaultUrlTransform` after our
// `rehype-sanitize` schema runs (see react-markdown's `post()`), and that
// default only allows `http(s)/irc(s)/mailto/xmpp` — it would silently blank
// out our `turnturn://` file-reference hrefs even though the sanitize schema
// allows them. This mirrors react-markdown's own relative-URL check, with
// our protocol allowlist substituted in.
const SAFE_PROTOCOL = new RegExp(`^(${[...ALLOWED_LINK_PROTOCOLS, WORKSPACE_FILE_PROTOCOL].join("|")})$`, "i");

export function markdownUrlTransform(value: string): string {
  const colon = value.indexOf(":");
  const questionMark = value.indexOf("?");
  const numberSign = value.indexOf("#");
  const slash = value.indexOf("/");

  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    SAFE_PROTOCOL.test(value.slice(0, colon))
  ) {
    return value;
  }

  return "";
}
