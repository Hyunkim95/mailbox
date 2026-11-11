"use client";
import { ArrowUpRight } from "lucide-react";
import type { MarketResult } from "../src/market";
import { SectionHead } from "./ui";

export function MarketResults({ result }: { result: MarketResult }) {
  return (
    <section>
      <SectionHead title={result.query}>
        <span className="ui-quiet">Channel3 · US catalogue</span>
      </SectionHead>
      <p className="ui-note">
        Listed product prices, checked{" "}
        {new Date(result.checked_at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
        . Shipping and taxes depend on the retailer.
      </p>
      {!result.products.length ? (
        <div className="ui-empty">
          <h3>No current offers matched</h3>
          <p>Try a broader product description.</p>
        </div>
      ) : (
        <div className="ui-products">
          {result.products.map((product) => (
            <article className="ui-product" key={product.id}>
              {product.image && (
                <img
                  src={product.image}
                  alt={product.title}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              )}
              <div>
                <small>{product.brand}</small>
                <h3>{product.title}</h3>
              </div>
              <div>
                {product.offers.slice(0, 3).map((offer, index) => (
                  <a
                    key={offer.url + index}
                    href={offer.url}
                    target="_blank"
                    rel="noopener noreferrer sponsored"
                  >
                    <span>{offer.merchant}</span>
                    <strong>
                      {new Intl.NumberFormat("en-US", {
                        style: "currency",
                        currency: offer.currency,
                      }).format(offer.amount)}
                    </strong>
                    <ArrowUpRight size={14} />
                  </a>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="ui-note">
        Open an offer to review and buy at the store.{" "}
        {result.products.some((p) => p.offers.some((o) => o.affiliate)) &&
          "Some product links may earn a commission."}
      </p>
    </section>
  );
}
