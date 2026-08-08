import { Readability } from "@mozilla/readability";
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

import { finalizeExtractedPage } from "../lib/content-capture";

export default defineUnlistedScript(() => {
  const fallbackText = document.body?.innerText ?? "";
  let fallbackHtml = document.body?.innerHTML ?? "";
  let readabilityHtml: string | null | undefined;
  let readabilityText: string | null | undefined;

  try {
    const clonedDocument = document.cloneNode(true) as Document;
    fallbackHtml = clonedDocument.body?.innerHTML ?? fallbackHtml;
    const article = new Readability(clonedDocument).parse();
    readabilityHtml = article?.content;
    readabilityText = article?.textContent;
  } catch {
    // The live document fallback still provides useful content for SPAs and
    // pages that exceed Readability's parsing limits.
  }

  return finalizeExtractedPage({
    fallbackHtml,
    fallbackText,
    readabilityHtml,
    readabilityText,
    url: window.location.href,
  });
});
