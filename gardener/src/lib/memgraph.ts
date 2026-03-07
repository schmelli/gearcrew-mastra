import neo4j, { type Driver, type Session } from "neo4j-driver";

let driver: Driver | null = null;

function getDriver(): Driver {
  if (!driver) {
    const uri = process.env.MEMGRAPH_URI;
    const user = process.env.MEMGRAPH_USER;
    const password = process.env.MEMGRAPH_PASSWORD;

    if (!uri) {
      throw new Error("MEMGRAPH_URI environment variable is required");
    }

    if ((user && !password) || (!user && password)) {
      console.warn(
        "[Memgraph] Only one of MEMGRAPH_USER/MEMGRAPH_PASSWORD is set — falling back to no auth",
      );
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

export function getReadSession(): Session {
  return getDriver().session({
    defaultAccessMode: neo4j.session.READ,
  });
}

export function getWriteSession(): Session {
  return getDriver().session({
    defaultAccessMode: neo4j.session.WRITE,
  });
}

export async function verifyConnection(): Promise<boolean> {
  const session = getReadSession();
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

/** Safely convert a Neo4j Integer or JS number to a plain number. */
export function toNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (neo4j.isInt(value)) return value.toNumber();
  return Number(value) || 0;
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
