import { prepareTestDatabase } from "@kanbot/shared/db/testing";

export default async function globalSetup() {
  await prepareTestDatabase();
}
