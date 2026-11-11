import type { AppStore } from "./app-store.ts";
import type { PersonalAgent } from "./app-model.ts";
import type { Service } from "@mailbox/service-sdk";
export const agentTemplates = [
  {
    key: "groceries",
    name: "Pantry",
    purpose:
      "Help with grocery newsletters, shopping offers and household restocking.",
  },
  {
    key: "entertainment",
    name: "Reel",
    purpose:
      "Find what I want to watch and keep subscriptions and renewal notices organized.",
  },
  {
    key: "dining",
    name: "Table",
    purpose:
      "Keep dining offers, reservations, deposits and restaurant messages together.",
  },
  {
    key: "pets",
    name: "Paws",
    purpose:
      "Watch pet-supply offers and help restock the correct food and bag size.",
  },
] as const;
export function defaultAgent(
  store: AppStore,
  owner: string,
  service: Pick<Service, "category">,
): PersonalAgent {
  const template = agentTemplates.find((t) => t.key === service.category)!;
  return (
    store.agents(owner).find((agent) => agent.template === template.key) ??
    store.createAgent(owner, {
      name: template.name,
      purpose: template.purpose,
      tags: [template.key],
      template: template.key,
    })
  );
}
export function sampleAgents(store: AppStore, owner: string) {
  return agentTemplates.map((template) =>
    defaultAgent(store, owner, { category: template.key }),
  );
}
