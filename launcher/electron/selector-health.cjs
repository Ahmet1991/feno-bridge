"use strict";

// Shared by the live Electron page probe and the fake-DOM unit tests.
// Keep this function self-contained: Electron serializes it into its existing renderer.
function measureSelectorHealth(document, specs, getStyle) {
  return specs.map(spec => {
    const matches = Array.from(document.querySelectorAll(spec.selector));
    const visible = matches.filter(element => {
      if (typeof element.getClientRects !== "function" || element.getClientRects().length === 0) {
        return false;
      }
      const style = getStyle(element);
      return style.visibility !== "hidden" && style.visibility !== "collapse";
    }).length;
    return { name: spec.name, matches: matches.length, visible };
  });
}

module.exports = { measureSelectorHealth };
