import neo4j, { type Driver, type Session } from "neo4j-driver";

let driver: Driver | null = null;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function getDriver(): Driver {
  if (!driver) {
    const uri = process.env.MEMGRAPH_URI;
    const user = process.env.MEMGRAPH_USER;
    const password = process.env.MEMGRAPH_PASSWORD;

    if (!uri) {
      throw new Error("MEMGRAPH_URI environment variable is required");
    }

    driver = neo4j.driver(
      uri,
      user && password ? neo4j.auth.basic(user, password) : undefined,
      {
        maxConnectionPoolSize: 10,
        connectionAcquisitionTimeout: 30000,
        connectionTimeout: 10000,
        maxTransactionRetryTime: 15000,
      },
    );
  }
  return driver;
}

export function getSession(): Session {
  return getDriver().session({ database: "memgraph" });
}

export async function verifyConnection(): Promise<boolean> {
  const session = getSession();
  try {
    await session.run("RETURN 1 AS ping");
    return true;
  } catch (error) {
    console.error("[Memgraph] Connection verification failed:", error);
    return false;
  } finally {
    await session.close();
  }
}

export async function executeWithRetry<T>(
  fn: (session: Session) => Promise<T>,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const session = getSession();
    try {
      return await fn(session);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(
        `[Memgraph] Attempt ${attempt}/${MAX_RETRIES} failed:`,
        lastError.message,
      );
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY_MS * attempt),
        );
      }
    } finally {
      await session.close();
    }
  }

  throw lastError;
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
