import { prepareTestDatabase } from "@kanbot/shared/testing";

export default async function globalSetup() {
  await prepareTestDatabase();
}
