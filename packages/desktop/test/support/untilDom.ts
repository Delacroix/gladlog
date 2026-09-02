/**
 * Resolve inside the MutationObserver callback (a microtask) the moment the
 * selector matches — deliberately WITHOUT testing-library's `waitFor`
 * tail (`setTimeout(0)` drain), so the continuation runs before React's
 * scheduler task that flushes passive effects. That is the window the GH #26
 * flakes lived in; the race tests use this helper to enter it on purpose.
 */
export function untilDom(
  container: HTMLElement,
  selector: string,
  timeoutMs = 2000,
): Promise<Element> {
  return new Promise((resolve, reject) => {
    const found = container.querySelector(selector);
    if (found) {
      resolve(found);
      return;
    }
    const timer = setTimeout(() => {
      mo.disconnect();
      reject(
        new Error(`untilDom: ${selector} did not appear in ${timeoutMs}ms`),
      );
    }, timeoutMs);
    const mo = new MutationObserver(() => {
      const el = container.querySelector(selector);
      if (el) {
        clearTimeout(timer);
        mo.disconnect();
        resolve(el);
      }
    });
    mo.observe(container, { childList: true, subtree: true, attributes: true });
  });
}

/** Same idea for text content: resolve as soon as the container's text matches. */
export function untilText(
  container: HTMLElement,
  re: RegExp,
  timeoutMs = 2000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (re.test(container.textContent ?? "")) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      mo.disconnect();
      reject(new Error(`untilText: ${re} did not appear in ${timeoutMs}ms`));
    }, timeoutMs);
    const mo = new MutationObserver(() => {
      if (re.test(container.textContent ?? "")) {
        clearTimeout(timer);
        mo.disconnect();
        resolve();
      }
    });
    mo.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}
