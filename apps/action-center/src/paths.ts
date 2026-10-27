import { join } from "node:path";
import { CompanyScope } from "../../wetrop/src/scope.ts";
export function actionCenterDir() {
  const s = new CompanyScope();
  return s.mkdir(".wetrop/database", true);
}
export function actionDbPath() {
  return join(actionCenterDir(), "actions.db");
}
