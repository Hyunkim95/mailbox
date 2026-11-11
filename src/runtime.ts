import { AppStore } from "./app-store.ts";
import { AppService } from "./app-service.ts";
declare global {
  var mailboxApp: AppService | undefined;
}
export function appService() {
  if (
    !globalThis.mailboxApp ||
    (process.env.NODE_ENV === "development" &&
      globalThis.mailboxApp.constructor !== AppService)
  ) {
    globalThis.mailboxApp?.store.close();
    globalThis.mailboxApp = new AppService(
      new AppStore(process.env.APP_DATABASE_PATH ?? "./data/app.sqlite"),
    );
  }
  return globalThis.mailboxApp;
}
