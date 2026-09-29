import type { CodexContentPart } from "../../types";
import { parseDataUrl } from "../image";

/**
 * Whether a tool's image reaches the running ChatGPT message by itself. An image with a data URL rides
 * in the MCP result, and ChatGPT shows that to the model inside the running message: on 28-29 Sep every
 * view_image code and Calculator screenshot was read correctly before any delivery turn ran, and
 * upstream, which has no delivery turn, read them all (6/6). An image sent as a resource link is not
 * visible. CODEX_WEB_GPT_TOOL_IMAGES=attach treats every image as unseen again, should ChatGPT stop
 * showing MCP images.
 */
export function toolImageReachesRunningMessage(imageUrl: string): boolean {
  if (process.env.CODEX_WEB_GPT_TOOL_IMAGES?.trim().toLowerCase() === "attach") return false;
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
