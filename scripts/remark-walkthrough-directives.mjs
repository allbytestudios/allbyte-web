/**
 * remark-walkthrough-directives — inline screenshot embeds for walkthrough prose.
 *
 * Lets Quinn place a shot at an exact point in the step-by-step flow rather than
 * only stacking them above the prose from frontmatter:
 *
 *   Head upstairs and open the chest.
 *
 *   ::shot[The chest is behind the bed]{name=EliasHouse}
 *
 *   Then take the door on the left.
 *
 * Files stay plain `.md` and sync stays verbatim — this is a RENDER-time
 * transform, it never rewrites her source.
 *
 * THE GATE (Quinn's requirement, 2026-07-21): an unknown directive name is a
 * hard error, not silent text. remark-directive's default behaviour is to leave
 * an unrecognised `::shoot` as literal prose — invisible on a page full of
 * screenshots, and exactly the failure our other gates exist to prevent. The
 * same check runs in sync-walkthrough.js so she catches it in her own container
 * without needing a build.
 *
 * Emits plain HTML (a remark plugin cannot mount a Svelte island). Inline shots
 * therefore get responsive srcset + caption + lightbox, but NOT the indicator
 * overlay — markers stay on frontmatter-declared shots, which render through the
 * island. Documented for Quinn rather than left to be discovered.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { visit } from "unist-util-visit";

const KNOWN = new Set(["shot"]);
const DIMS_PATH = resolve("./src/data/walkthrough-stills.json");
const SIZES = "(max-width: 900px) 100vw, 800px";

function loadDims() {
  try {
    return existsSync(DIMS_PATH) ? JSON.parse(readFileSync(DIMS_PATH, "utf8")) : {};
  } catch {
    return {};
  }
}

export default function remarkWalkthroughDirectives() {
  return (tree, file) => {
    // Only applies to walkthrough content; other collections use plain markdown
    // and must not inherit this vocabulary.
    const path = String(file.path ?? "").replace(/\\/g, "/");
    if (!path.includes("/content/walkthrough/")) return;

    const dims = loadDims();

    visit(tree, (node) => {
      if (
        node.type !== "textDirective" &&
        node.type !== "leafDirective" &&
        node.type !== "containerDirective"
      ) {
        return;
      }

      if (!KNOWN.has(node.name)) {
        throw new Error(
          `[walkthrough] unknown directive "::${node.name}" in ${path}\n` +
            `  Known directives: ${[...KNOWN].map((n) => `::${n}`).join(", ")}\n` +
            `  A typo'd directive would otherwise render as literal text.`
        );
      }

      if (node.name === "shot") {
        if (node.type !== "leafDirective") {
          throw new Error(
            `[walkthrough] ::shot must be a leaf directive (::shot[caption]{name=X}) in ${path}`
          );
        }
        const attrs = node.attributes ?? {};
        const name = attrs.name;
        if (!name) {
          throw new Error(
            `[walkthrough] ::shot is missing {name=...} in ${path}\n` +
              `  Use the still's basename, e.g. ::shot[caption]{name=EliasHouse}`
          );
        }
        const size = dims[name];
        if (!size) {
          throw new Error(
            `[walkthrough] ::shot{name=${name}} has no synced still in ${path}\n` +
              `  Expected ${name} in raw_stills/. Run the sync to convert it first.`
          );
        }

        const srcset = (size.widths ?? []).map((w) => `/walkthrough/${name}-${w}.webp ${w}w`).join(", ");
        const caption = node.children?.length ? node.children : null;

        node.data ??= {};
        node.data.hName = "figure";
        node.data.hProperties = { class: "wt-inline-shot" };
        node.children = [
          {
            type: "emphasis", // placeholder node type; hName below replaces it
            data: {
              hName: "button",
              hProperties: {
                type: "button",
                class: "inline-shot-btn",
                "data-lightbox": name,
                "data-alt": caption ? "" : name,
                "aria-label": `Enlarge screenshot: ${name}`,
              },
            },
            children: [
              {
                type: "emphasis",
                data: {
                  hName: "img",
                  hProperties: {
                    src: `/walkthrough/${name}.webp`,
                    ...(srcset ? { srcset, sizes: SIZES } : {}),
                    width: size.w,
                    height: size.h,
                    loading: "lazy",
                    decoding: "async",
                    alt: name,
                  },
                },
                children: [],
              },
            ],
          },
          ...(caption
            ? [
                {
                  type: "paragraph",
                  data: { hName: "figcaption", hProperties: { class: "inline-shot-cap" } },
                  children: caption,
                },
              ]
            : []),
        ];
      }
    });
  };
}
