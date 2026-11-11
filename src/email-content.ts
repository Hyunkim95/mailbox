import { load } from "cheerio";

export function readEmailContent(input: {
  text?: string | undefined;
  html?: string | undefined;
  preview?: string | undefined;
}) {
  const images: { source: string; alt: string }[] = [];
  let htmlText = "";
  if (input.html) {
    const $ = load(input.html.slice(0, 1_000_000));
    $("script,style,head,noscript").remove();
    $("img").each((_index, image) => {
      const element = $(image),
        source = element.attr("src") ?? "",
        width = Number(element.attr("width")),
        height = Number(element.attr("height"));
      if ((width > 0 && width <= 2) || (height > 0 && height <= 2)) return;
      if (/^(https:\/\/|cid:)/i.test(source) && images.length < 20)
        images.push({ source, alt: element.attr("alt") ?? "" });
    });
    $("br").replaceWith("\n");
    $("p,div,tr,li").append("\n");
    // Preheaders often contain the only text version of a promotional banner.
    // Do not discard display:none text; never execute HTML, scripts or links.
    htmlText = $.root()
      .text()
      .replace(/[\t ]+/g, " ")
      .replace(/\n\s*\n+/g, "\n")
      .trim();
  }
  const text = input.text?.trim() ?? "",
    preview = input.preview?.trim() ?? "";
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const parts = [text];
  if (htmlText && !normalize(text).includes(normalize(htmlText)))
    parts.push(htmlText);
  if (
    preview &&
    !parts.some((part) => normalize(part).includes(normalize(preview)))
  )
    parts.push(preview);
  const body = parts.filter(Boolean).join("\n\n");
  const hasOfferText =
    /\d+(?:\.\d+)?\s*%|(?:[$€£]|USD|AED)\s*\d|(?:code|coupon)\s*:?\s*[a-z0-9]{3,}/i.test(
      body,
    );
  return {
    text: body,
    images,
    needsVision: images.length > 0 && !hasOfferText,
  };
}

export function nativePromotionFacts(subject: string, text: string) {
  const percent = (pattern: RegExp) => {
    const value = pattern.exec(text)?.[1];
    if (!value) return null;
    const number = Number(value);
    return number >= 0 && number <= 100 ? number : null;
  };
  return {
    coupon_code:
      /(?:use\s+)?code\s*:?\s*([a-z0-9]{3,20})\b/i.exec(text)?.[1] ?? null,
    discount_percent: percent(/(\d+(?:\.\d+)?)\s*%\s*(?:off|discount)/i),
    cashback_percent: percent(/(\d+(?:\.\d+)?)\s*%\s*cashback/i),
    date_hint: /\b\d{1,2}\.\d{1,2}\b/.exec(subject)?.[0] ?? null,
  };
}
