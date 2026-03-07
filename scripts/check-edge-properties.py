#!/usr/bin/env python3
"""Check edge properties in Memgraph."""

import os
from neo4j import GraphDatabase

host = os.getenv("MEMGRAPH_HOST", "geargraph.gearshack.app")
port = os.getenv("MEMGRAPH_PORT", "7688")
user = os.getenv("MEMGRAPH_USER", "memgraph")
password = os.getenv("MEMGRAPH_PASSWORD", "geargraph2025")

driver = GraphDatabase.driver(f"bolt://{host}:{port}", auth=(user, password))

print("=== SUITABLE_FOR Edge Properties ===")
with driver.session() as session:
    result = session.run("MATCH ()-[r:SUITABLE_FOR]->() RETURN keys(r) AS props LIMIT 1")
    record = result.single()
    if record:
        print(f"Properties: {record['props']}")
    else:
        print("No SUITABLE_FOR edges found")

    # Get sample with values
    result = session.run("MATCH ()-[r:SUITABLE_FOR]->() RETURN r LIMIT 1")
    record = result.single()
    if record:
        rel = record['r']
        print(f"Sample values: {dict(rel)}")

print("\n=== COMPETES_WITH Edge Properties ===")
with driver.session() as session:
    result = session.run("MATCH ()-[r:COMPETES_WITH]->() RETURN keys(r) AS props LIMIT 1")
    record = result.single()
    if record:
        print(f"Properties: {record['props']}")
    else:
        print("No COMPETES_WITH edges found")

    # Get sample with values
    result = session.run("MATCH ()-[r:COMPETES_WITH]->() RETURN r LIMIT 1")
    record = result.single()
    if record:
        rel = record['r']
        print(f"Sample values: {dict(rel)}")

print("\n=== Edge Counts ===")
with driver.session() as session:
    result = session.run("MATCH ()-[r:SUITABLE_FOR]->() RETURN count(r) AS cnt")
    cnt = result.single()['cnt']
    print(f"SUITABLE_FOR edges: {cnt}")

    result = session.run("MATCH ()-[r:COMPETES_WITH]->() RETURN count(r) AS cnt")
    cnt = result.single()['cnt']
    print(f"COMPETES_WITH edges: {cnt}")

driver.close()
