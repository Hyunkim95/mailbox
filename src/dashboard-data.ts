import type { AppState } from "./app-model.ts";
import type {
  AgDataSourcesDefinition,
  AgFieldDefinition,
  AgReportState,
} from "ag-studio";

export const dashboardNiches = [
  "all",
  "entertainment",
  "groceries",
  "dining",
  "pets",
] as const;
export type DashboardNiche = (typeof dashboardNiches)[number];
export function dashboardData(
  state: AppState,
  niche: DashboardNiche,
): AgDataSourcesDefinition {
  const category = (serviceId: string) =>
    state.wallets.find((wallet) => wallet.service_id === serviceId)?.category ??
    (serviceId === "basil-market"
      ? "groceries"
      : serviceId === "daily-paws"
        ? "pets"
        : serviceId === "marina-table"
          ? "dining"
          : "entertainment");
  const include = (serviceId: string) =>
    niche === "all" || category(serviceId) === niche;
  const fields = (
    names: string[],
    numeric: string[] = [],
  ): AgFieldDefinition[] =>
    names.map((id) => ({
      id,
      name: id.replaceAll("_", " "),
      format: numeric.includes(id) ? "decimalFormat" : "textFormat",
    }));
  return {
    sources: [
      {
        id: "wallets",
        name: "Service wallets",
        description:
          "One row per service. Amounts in USD, for each wallet's own current weekly or monthly period. Do not combine caps across periods.",
        data: state.wallets
          .filter((w) => include(w.service_id))
          .map((w) => ({
            service: w.name,
            niche: w.category,
            period: w.period,
            spent_USD: w.spent / 100,
            reserved_USD: w.reserved / 100,
            available_USD: w.available / 100,
            cap_USD: w.cap / 100,
            permission: w.mode,
            status: w.status,
          })),
        fields: fields(
          [
            "service",
            "niche",
            "period",
            "spent_USD",
            "reserved_USD",
            "available_USD",
            "cap_USD",
            "permission",
            "status",
          ],
          ["spent_USD", "reserved_USD", "available_USD", "cap_USD"],
        ),
      },
      {
        id: "messages",
        name: "Service messages",
        description:
          "Actual stored messages. Fixture previews remain labeled. Email amounts are advertised facts, never payment proof.",
        data: state.messages
          .filter((m) => include(m.service_id))
          .map((m) => ({
            subject: m.subject,
            service: m.service_id,
            niche: category(m.service_id),
            kind: m.kind,
            received: m.received_at,
            amount_USD:
              typeof m.facts.amount_minor === "number"
                ? m.facts.amount_minor / 100
                : null,
            origin: m.origin,
          })),
        fields: fields(
          [
            "subject",
            "service",
            "niche",
            "kind",
            "received",
            "amount_USD",
            "origin",
          ],
          ["amount_USD"],
        ),
      },
      {
        id: "actions",
        name: "Wallet actions",
        description:
          "Proposal history. Only PAID is a completed payment; all other statuses must stay distinct.",
        data: state.proposals
          .filter((p) => include(p.service_id))
          .map((p) => ({
            action: p.title,
            service: p.service_id,
            niche: category(p.service_id),
            kind: p.kind,
            status: p.status,
            amount_USD: p.amount / 100,
            created: p.created_at,
          })),
        fields: fields(
          [
            "action",
            "service",
            "niche",
            "kind",
            "status",
            "amount_USD",
            "created",
          ],
          ["amount_USD"],
        ),
      },
    ],
  };
}
export function defaultDashboard(showWallets = true): AgReportState {
  const report: AgReportState = {
    selectedPageId: "overview",
    pages: [
      {
        id: "overview",
        layout: { minWidth: 280 },
        widgets: {
          wallets: {
            type: "grid",
            dataMapping: {
              cols: [
                { id: "wallets.service" },
                { id: "wallets.period" },
                { id: "wallets.spent_USD" },
                { id: "wallets.available_USD" },
                { id: "wallets.permission" },
              ],
            },
            format: { title: { enabled: true, text: "Your service wallets" } },
          },
          volume: {
            type: "column-chart-grouped",
            dataMapping: {
              categoryKey: [{ id: "messages.kind" }],
              valueKey: [{ id: "messages.subject", aggregation: "count" }],
            },
            format: {
              title: { enabled: true, text: "What your services are sending" },
            },
          },
          messages: {
            type: "grid",
            dataMapping: {
              cols: [
                { id: "messages.subject" },
                { id: "messages.kind" },
                { id: "messages.origin" },
              ],
            },
            format: { title: { enabled: true, text: "Messages at a glance" } },
          },
        },
        widgetLayout: {
          wallets: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 14 },
          volume: { xTrack: 0, yTrack: 14, xSpan: 12, ySpan: 20 },
          messages: { xTrack: 12, yTrack: 14, xSpan: 12, ySpan: 20 },
        },
      },
    ],
    panels: {
      data: { collapsed: true },
      edit: { collapsed: true },
      filters: { collapsed: true },
    },
  };
  if (!showWallets) {
    const page = report.pages[0]!;
    delete page.widgets!.wallets;
    delete page.widgetLayout!.wallets;
    page.widgetLayout!.volume = { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 30 };
    page.widgetLayout!.messages = {
      xTrack: 12,
      yTrack: 0,
      xSpan: 12,
      ySpan: 30,
    };
  }
  return report;
}
