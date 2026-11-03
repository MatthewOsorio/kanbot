import { prepareTestDatabase } from "@kanbot/shared/db/testing";
import { TEST_DATABASE_URL } from "../playwright.config";

/** Creates the e2e database if missing and brings it to the latest migration. */
export default async function globalSetup() {
  await prepareTestDatabase(TEST_DATABASE_URL);
}
