"use client";
import type { AppState, PublicAgent } from "../src/app-model";
export default function DashboardUnavailable({
  agent,
}: {
  state: AppState;
  agent?: PublicAgent;
}) {
  return (
    <section className="niche-dashboard" data-testid="dashboard-unavailable">
      <div className="page-heading">
        <div>
          <div className="eyebrow">Your view of your services</div>
          <h2>{agent ? `${agent.name}’s dashboard` : "Your dashboard"}</h2>
        </div>
      </div>
      <div className="empty-services">
        <h3>Dashboards aren’t available in this hosted demo.</h3>
        <p>
          You can still review this agent’s inbox, service wallets and activity.
        </p>
      </div>
    </section>
  );
}
