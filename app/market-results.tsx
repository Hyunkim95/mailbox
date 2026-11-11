"use client";
import { ArrowUpRight } from "lucide-react";
import type { MarketResult } from "../src/market";
export function MarketResults({ result }: { result: MarketResult }) {
  return (
    <section className="market-results">
      <div className="section-heading">
        <div>
          <div className="eyebrow">Across the market</div>
          <h2>{result.query}</h2>
        </div>
        <span className="source-pill">Channel3 · US catalogue</span>
      </div>
      <p className="market-caption">
        Listed product prices, checked{" "}
        {new Date(result.checked_at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
        . Shipping and taxes depend on the retailer.
      </p>
      {!result.products.length ? (
        <div className="answer-card">
          No current offers matched this search. Try a broader product
          description.
        </div>
      ) : (
        <div className="market-grid">
          {result.products.map((product) => (
            <article className="market-product" key={product.id}>
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
                {product.offers.slice(0, 3).map((offer, index) => (
                  <a
                    key={offer.url + index}
                    href={offer.url}
                    target="_blank"
                    rel="noopener noreferrer sponsored"
                    className="market-offer"
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
      <p className="market-caption">
        Open an offer to review and buy at the store.{" "}
        {result.products.some((p) => p.offers.some((o) => o.affiliate)) &&
          "Some product links may earn a commission."}
      </p>
    </section>
  );
}
