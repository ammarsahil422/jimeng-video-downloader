/**
 * Real script injection for saved ad-slot code.
 *
 * Ad-network code (Adsterra invoke code, AdSense) only earns when its
 * <script> actually EXECUTES. Scripts inserted through innerHTML /
 * dangerouslySetInnerHTML do NOT execute, so saved ad code must never be
 * rendered that way. These helpers parse the saved snippet and rebuild it
 * with real DOM nodes: every <script> becomes a
 * document.createElement("script") appended in the snippet's original
 * order, so inline code (e.g. Adsterra's `atOptions = {...}`) runs
 * synchronously on append, and an external src script then loads
 * asynchronously — it never blocks rendering or the download flow.
 * Non-script markup (e.g. an AdSense <ins> element) is appended as real
 * nodes before the scripts that need it.
 *
 * The code injected here is the site owner's own ad code, saved by the
 * admin in Admin → Ads. It is a public embed snippet by design — the same
 * bytes any visitor's browser would receive inside the page HTML.
 */

function buildScript(el: HTMLScriptElement): HTMLScriptElement {
  const s = document.createElement("script");
  for (const attr of Array.from(el.attributes)) {
    s.setAttribute(attr.name, attr.value);
  }
  if (el.src) {
    // External ad scripts always load async — they must never block the
    // page or a download. (Dynamically created scripts are async by
    // default; this states it explicitly.)
    s.async = true;
  } else {
    s.textContent = el.textContent;
  }
  return s;
}

/** Appends one parsed node to a host, rebuilding <script> nodes so they execute. */
function appendAdNode(host: Node, node: ChildNode): Node | null {
  if (node.nodeName === "SCRIPT") {
    const s = buildScript(node as HTMLScriptElement);
    host.appendChild(s);
    return s;
  }
  if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
    const clone = document.importNode(node, true);
    host.appendChild(clone);
    return clone;
  }
  return null;
}

/**
 * Injects a saved ad snippet into `host`, replacing whatever was there.
 * Parses with DOMParser and appends the nodes in the snippet's original
 * order. NOTE: the parser puts leading <script> elements in the parsed
 * document's <head> (they precede any body content), so head nodes must
 * be injected first — iterating body only would silently drop the
 * scripts, which is exactly the ad code that has to execute. The
 * caller owns cleanup: call `host.replaceChildren()` (or re-inject) to
 * remove the ad.
 */
export function injectAdCode(host: HTMLElement, code: string): void {
  host.replaceChildren();
  const doc = new DOMParser().parseFromString(code, "text/html");
  for (const node of Array.from(doc.head.childNodes)) {
    appendAdNode(host, node);
  }
  for (const node of Array.from(doc.body.childNodes)) {
    appendAdNode(host, node);
  }
}

/**
 * Injects head-slot code (meta / link / script) into document.head.
 * Returns a cleanup that removes exactly the nodes it added. A bare
 * snippet has no <head> wrapper, so DOMParser may place scripts in the
 * body — both are injected, head nodes first.
 */
export function injectHeadCode(code: string): () => void {
  const doc = new DOMParser().parseFromString(code, "text/html");
  const added: Node[] = [];
  for (const node of Array.from(doc.head.childNodes)) {
    const addedNode = appendAdNode(document.head, node);
    if (addedNode) added.push(addedNode);
  }
  for (const node of Array.from(doc.body.childNodes)) {
    const addedNode = appendAdNode(document.head, node);
    if (addedNode) added.push(addedNode);
  }
  return () => {
    for (const n of added) {
      n.parentNode?.removeChild(n);
    }
  };
}
