import type { CodexContentPart } from "../../types";
import { parseDataUrl } from "../image";

/**
 * Whether a tool's image reaches the running ChatGPT message by itself.
 *
 * On 28-29 Sep an image riding in the MCP result was shown to the model: every view_image code and
 * Calculator screenshot was read before any delivery turn ran. By the evening of 30 Sep it no longer
 * was. ChatGPT still stored the image, but the model answered "the call returned no image" 0/3 times
 * for kod.png on DEV and 0/2 on the installed bridge, even for a 140 px code. It re-opened the image
 * up to five times, ignoring the note beside it, then fell back to reading the file with Python.
 * The same image attached to a follow-up message was read correctly 2/2.
 *
 * So every image is delivered by attachment again. CODEX_WEB_GPT_TOOL_IMAGES=inline trusts the MCP
 * result instead, for when ChatGPT shows those images again. An image sent as a resource link was
 * never visible.
 */
export function toolImageReachesRunningMessage(imageUrl: string): boolean {
  if (process.env.CODEX_WEB_GPT_TOOL_IMAGES?.trim().toLowerCase() !== "inline") return false;
  return parseDataUrl(imageUrl) !== null;
}

/**
 * The images of a tool result that still need a delivery turn. Delivering a visible one again only
 * cost time: a "cannot be attached" notice made the model open kod.png twice (+24 s), the delivery
 * turn took 33 s to append an "Evet, … uyuşuyor" line, and the next Codex turn uploaded the same
 * images once more (29 Sep, Kanal 2).
 */
export function toolImagesNeedingDelivery(content: string | CodexContentPart[]): Array<{ imageUrl: string }> {
  if (typeof content === "string") return [];
  return content.flatMap(part => part.type === "image" && !toolImageReachesRunningMessage(part.imageUrl)
    ? [{ imageUrl: part.imageUrl }]
    : []);
}
