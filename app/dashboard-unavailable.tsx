"use client";
import type { AppState, PublicAgent } from "../src/app-model";

export default function DashboardUnavailable({
  agent,
}: {
  state: AppState;
  agent?: PublicAgent;
}) {
  return (
    <section className="ui-col" data-testid="dashboard-unavailable">
      <div className="ui-empty">
        <h2>Dashboards are not available in this workspace</h2>
        <p>
          You can still review {agent ? `${agent.name}’s` : "each agent’s"}{" "}
          inbox, services and activity.
        </p>
      </div>
    </section>
  );
}
