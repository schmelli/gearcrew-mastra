#!/usr/bin/env python3
"""Test write transaction to Memgraph."""

import os
from neo4j import GraphDatabase

host = os.getenv("MEMGRAPH_HOST", "127.0.0.1")
port = os.getenv("MEMGRAPH_PORT", "7688")
user = os.getenv("MEMGRAPH_USER", "memgraph")
password = os.getenv("MEMGRAPH_PASSWORD", "geargraph2025")

driver = GraphDatabase.driver(f"bolt://{host}:{port}", auth=(user, password))

# Get a test item with a gearId
with driver.session() as session:
    result = session.run("MATCH (g:GearItem) WHERE g.gearId IS NOT NULL AND g.embedding_vector IS NULL RETURN g.gearId LIMIT 1")
    record = result.single()
    if record:
        gear_id = record["g.gearId"]
        print(f"Testing with gearId: {gear_id}")
    else:
        print("No items found!")
        driver.close()
        exit(1)

# Try direct session.run with consume()
with driver.session() as session:
    result = session.run(
        "MATCH (g:GearItem {gearId: $gid}) SET g.test_field = $val RETURN g.gearId",
        gid=gear_id,
        val="test123"
    )
    summary = result.consume()
    print(f"Properties set: {summary.counters.properties_set}")

# Check if it was saved
with driver.session() as session:
    result = session.run("MATCH (g:GearItem {gearId: $gid}) RETURN g.test_field", gid=gear_id)
    record = result.single()
    val = record["g.test_field"] if record else "NOT FOUND"
    print(f"Test field value: {val}")

driver.close()
