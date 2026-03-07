#!/usr/bin/env python3
"""
GearGraph Embedding Generator
=============================
Generiert OpenAI Embeddings für alle GearItems ohne embedding_vector
und speichert sie in Memgraph.

Voraussetzungen:
    pip install neo4j openai python-dotenv tqdm

Umgebungsvariablen (.env):
    OPENAI_API_KEY=sk-...
    MEMGRAPH_HOST=localhost
    MEMGRAPH_PORT=7687
    MEMGRAPH_USER=memgraph
    MEMGRAPH_PASSWORD=geargraph2025

Verwendung:
    python scripts/generate-embeddings.py
    python scripts/generate-embeddings.py --batch-size 50 --dry-run
    python scripts/generate-embeddings.py --limit 100  # nur erste 100
    python scripts/generate-embeddings.py --stats-only  # nur Statistiken
"""

import os
import sys
import argparse
import logging
from datetime import datetime
from typing import List, Dict, Optional
from dataclasses import dataclass

from dotenv import load_dotenv
from neo4j import GraphDatabase
from openai import OpenAI
from tqdm import tqdm

# Logging Setup
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('embedding_generator.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# Konfiguration
EMBEDDING_MODEL = "text-embedding-3-small"  # 1536 Dimensionen, günstig
EMBEDDING_DIMENSION = 1536
BATCH_SIZE_OPENAI = 100  # OpenAI erlaubt bis zu 2048 Texte pro Request
BATCH_SIZE_DB = 50  # Wie viele Items pro DB-Transaction


@dataclass
class EmbeddableNode:
    """Repräsentiert einen Node aus der Datenbank."""
    node_id: str  # Internal ID or property ID
    node_type: str  # 'GearItem' or 'Insight'
    text_content: str  # Pre-computed text for embedding

    def to_embedding_text(self) -> str:
        """Erzeugt den Text, der embedded werden soll."""
        return self.text_content


@dataclass
class EmbeddableEdge:
    """Repräsentiert eine Edge aus der Datenbank."""
    edge_id: str  # Internal Edge ID
    edge_type: str  # 'SUITABLE_FOR' or 'COMPETES_WITH'
    text_content: str  # Text for embedding (reasoning or differentiation)
    source_name: str  # Name of source node (for context)
    target_name: str  # Name of target node (for context)

    def to_embedding_text(self) -> str:
        """Erzeugt den Text, der embedded werden soll."""
        # Include context from source and target nodes
        return f"{self.source_name} -> {self.target_name}: {self.text_content}"


@dataclass
class GearItem:
    """Repräsentiert ein GearItem aus der Datenbank."""
    gear_id: str
    name: str
    product_type: Optional[str]
    description: Optional[str]
    brand: Optional[str]

    def to_embedding_text(self) -> str:
        """Erzeugt den Text, der embedded werden soll."""
        parts = []

        if self.name:
            parts.append(self.name)

        if self.product_type:
            parts.append(f"Type: {self.product_type}")

        if self.brand:
            parts.append(f"Brand: {self.brand}")

        if self.description:
            # Beschreibung auf 500 Zeichen begrenzen für Effizienz
            desc = self.description[:500]
            parts.append(desc)

        return " | ".join(parts)


class MemgraphConnection:
    """Verwaltet die Verbindung zu Memgraph."""

    def __init__(self, host: str, port: int, user: str = "", password: str = ""):
        uri = f"bolt://{host}:{port}"
        auth = (user, password) if user and password else None
        self.driver = GraphDatabase.driver(uri, auth=auth)
        logger.info(f"Verbunden mit Memgraph: {uri}")

    def close(self):
        self.driver.close()

    def verify_connection(self) -> bool:
        """Prüft die Verbindung."""
        try:
            with self.driver.session() as session:
                result = session.run("RETURN 1 AS test")
                return result.single()["test"] == 1
        except Exception as e:
            logger.error(f"Verbindungsfehler: {e}")
            return False

    def get_items_without_embeddings(self, limit: Optional[int] = None) -> List[GearItem]:
        """Holt alle GearItems ohne embedding_vector."""
        # Use internal node ID for items without gearId
        query = """
            MATCH (g:GearItem)
            WHERE g.embedding_vector IS NULL
            RETURN COALESCE(g.gearId, toString(id(g))) AS gear_id,
                   g.name AS name,
                   g.productType AS product_type,
                   g.description AS description,
                   g.brand AS brand,
                   g.gearId IS NULL AS use_internal_id,
                   id(g) AS internal_id
        """
        if limit:
            query += f" LIMIT {limit}"

        with self.driver.session() as session:
            result = session.run(query)
            items = [
                GearItem(
                    gear_id=record["gear_id"],
                    name=record["name"],
                    product_type=record["product_type"],
                    description=record["description"],
                    brand=record["brand"]
                )
                for record in result
            ]

        logger.info(f"Gefunden: {len(items)} GearItems ohne Embeddings")
        return items

    def update_embeddings(self, updates: List[Dict]):
        """Speichert Embeddings in Memgraph."""
        def _update_batch(tx, updates_batch):
            for update in updates_batch:
                gear_id = update["gear_id"]
                # Check if gear_id is numeric (internal ID) or string (gearId)
                if gear_id.isdigit():
                    # Use internal node ID
                    query = """
                        MATCH (g:GearItem)
                        WHERE id(g) = $internal_id
                        SET g.embedding_vector = $embedding,
                            g.embedding_updated_at = $updated_at,
                            g.embedding_model = $model
                    """
                    tx.run(query,
                        internal_id=int(gear_id),
                        embedding=update["embedding"],
                        updated_at=update["updated_at"],
                        model=update["model"]
                    )
                else:
                    # Use gearId property
                    query = """
                        MATCH (g:GearItem {gearId: $gear_id})
                        SET g.embedding_vector = $embedding,
                            g.embedding_updated_at = $updated_at,
                            g.embedding_model = $model
                    """
                    tx.run(query,
                        gear_id=gear_id,
                        embedding=update["embedding"],
                        updated_at=update["updated_at"],
                        model=update["model"]
                    )

        # Use write transaction to ensure commits
        with self.driver.session() as session:
            session.execute_write(_update_batch, updates)

    def get_embedding_stats(self, node_type: str = "GearItem") -> Dict:
        """Holt Statistiken über Embeddings."""
        with self.driver.session() as session:
            # Get total count
            total_result = session.run(f"MATCH (g:{node_type}) RETURN count(g) AS total")
            total = total_result.single()["total"]

            # Get count with embeddings
            emb_result = session.run(f"MATCH (g:{node_type}) WHERE g.embedding_vector IS NOT NULL RETURN count(g) AS cnt")
            with_emb = emb_result.single()["cnt"]

            return {
                "total": total,
                "with_embedding": with_emb,
                "without_embedding": total - with_emb
            }

    def get_insights_without_embeddings(self, limit: Optional[int] = None) -> List[EmbeddableNode]:
        """Holt alle Insight Nodes ohne embedding_vector."""
        query = """
            MATCH (i:Insight)
            WHERE i.embedding_vector IS NULL
            RETURN toString(id(i)) AS node_id,
                   COALESCE(i.summary, '') AS summary,
                   COALESCE(i.content, '') AS content
        """
        if limit:
            query += f" LIMIT {limit}"

        with self.driver.session() as session:
            result = session.run(query)
            items = []
            for record in result:
                # Combine summary and content for embedding
                summary = record["summary"] or ""
                content = record["content"] or ""
                # Limit content to 1000 chars for efficiency
                text = f"{summary}\n\n{content[:1000]}" if content else summary
                items.append(EmbeddableNode(
                    node_id=record["node_id"],
                    node_type="Insight",
                    text_content=text.strip()
                ))

        logger.info(f"Gefunden: {len(items)} Insight Nodes ohne Embeddings")
        return items

    def update_insight_embeddings(self, updates: List[Dict]):
        """Speichert Embeddings für Insight Nodes in Memgraph."""
        def _update_batch(tx, updates_batch):
            for update in updates_batch:
                query = """
                    MATCH (i:Insight)
                    WHERE id(i) = $internal_id
                    SET i.embedding_vector = $embedding,
                        i.embedding_updated_at = $updated_at,
                        i.embedding_model = $model
                """
                tx.run(query,
                    internal_id=int(update["node_id"]),
                    embedding=update["embedding"],
                    updated_at=update["updated_at"],
                    model=update["model"]
                )

        with self.driver.session() as session:
            session.execute_write(_update_batch, updates)

    def get_glossary_without_embeddings(self, limit: Optional[int] = None) -> List[EmbeddableNode]:
        """Holt alle GlossaryTerm Nodes ohne embedding_vector."""
        query = """
            MATCH (g:GlossaryTerm)
            WHERE g.embedding_vector IS NULL
            RETURN toString(id(g)) AS node_id,
                   COALESCE(g.name, '') AS name,
                   COALESCE(g.category, '') AS category,
                   COALESCE(g.definition, '') AS definition
        """
        if limit:
            query += f" LIMIT {limit}"

        with self.driver.session() as session:
            result = session.run(query)
            items = []
            for record in result:
                # Combine name, category, and definition for embedding
                name = record["name"] or ""
                category = record["category"] or ""
                definition = record["definition"] or ""
                text = f"{name} ({category}): {definition}" if category else f"{name}: {definition}"
                items.append(EmbeddableNode(
                    node_id=record["node_id"],
                    node_type="GlossaryTerm",
                    text_content=text.strip()
                ))

        logger.info(f"Gefunden: {len(items)} GlossaryTerm Nodes ohne Embeddings")
        return items

    def update_glossary_embeddings(self, updates: List[Dict]):
        """Speichert Embeddings für GlossaryTerm Nodes in Memgraph."""
        def _update_batch(tx, updates_batch):
            for update in updates_batch:
                query = """
                    MATCH (g:GlossaryTerm)
                    WHERE id(g) = $internal_id
                    SET g.embedding_vector = $embedding,
                        g.embedding_updated_at = $updated_at,
                        g.embedding_model = $model
                """
                tx.run(query,
                    internal_id=int(update["node_id"]),
                    embedding=update["embedding"],
                    updated_at=update["updated_at"],
                    model=update["model"]
                )

        with self.driver.session() as session:
            session.execute_write(_update_batch, updates)

    def get_suitable_for_without_embeddings(self, limit: Optional[int] = None) -> List[EmbeddableEdge]:
        """Holt alle SUITABLE_FOR Edges ohne embedding_vector."""
        query = """
            MATCH (source)-[r:SUITABLE_FOR]->(target)
            WHERE r.embedding_vector IS NULL AND r.reasoning IS NOT NULL
            RETURN toString(id(r)) AS edge_id,
                   COALESCE(r.reasoning, '') AS reasoning,
                   COALESCE(source.name, source.gearId, toString(id(source))) AS source_name,
                   COALESCE(target.name, target.title, toString(id(target))) AS target_name
        """
        if limit:
            query += f" LIMIT {limit}"

        with self.driver.session() as session:
            result = session.run(query)
            items = []
            for record in result:
                reasoning = record["reasoning"] or ""
                if reasoning.strip():  # Only include edges with actual reasoning text
                    items.append(EmbeddableEdge(
                        edge_id=record["edge_id"],
                        edge_type="SUITABLE_FOR",
                        text_content=reasoning,
                        source_name=record["source_name"] or "",
                        target_name=record["target_name"] or ""
                    ))

        logger.info(f"Gefunden: {len(items)} SUITABLE_FOR Edges ohne Embeddings")
        return items

    def update_suitable_for_embeddings(self, updates: List[Dict]):
        """Speichert Embeddings für SUITABLE_FOR Edges in Memgraph."""
        def _update_batch(tx, updates_batch):
            for update in updates_batch:
                query = """
                    MATCH ()-[r:SUITABLE_FOR]->()
                    WHERE id(r) = $edge_id
                    SET r.embedding_vector = $embedding,
                        r.embedding_updated_at = $updated_at,
                        r.embedding_model = $model
                """
                tx.run(query,
                    edge_id=int(update["edge_id"]),
                    embedding=update["embedding"],
                    updated_at=update["updated_at"],
                    model=update["model"]
                )

        with self.driver.session() as session:
            session.execute_write(_update_batch, updates)

    def get_competes_with_without_embeddings(self, limit: Optional[int] = None) -> List[EmbeddableEdge]:
        """Holt alle COMPETES_WITH Edges ohne embedding_vector."""
        query = """
            MATCH (source)-[r:COMPETES_WITH]->(target)
            WHERE r.embedding_vector IS NULL AND r.differentiation IS NOT NULL
            RETURN toString(id(r)) AS edge_id,
                   COALESCE(r.differentiation, '') AS differentiation,
                   COALESCE(source.name, source.gearId, toString(id(source))) AS source_name,
                   COALESCE(target.name, target.gearId, toString(id(target))) AS target_name
        """
        if limit:
            query += f" LIMIT {limit}"

        with self.driver.session() as session:
            result = session.run(query)
            items = []
            for record in result:
                differentiation = record["differentiation"] or ""
                if differentiation.strip():  # Only include edges with actual text
                    items.append(EmbeddableEdge(
                        edge_id=record["edge_id"],
                        edge_type="COMPETES_WITH",
                        text_content=differentiation,
                        source_name=record["source_name"] or "",
                        target_name=record["target_name"] or ""
                    ))

        logger.info(f"Gefunden: {len(items)} COMPETES_WITH Edges ohne Embeddings")
        return items

    def update_competes_with_embeddings(self, updates: List[Dict]):
        """Speichert Embeddings für COMPETES_WITH Edges in Memgraph."""
        def _update_batch(tx, updates_batch):
            for update in updates_batch:
                query = """
                    MATCH ()-[r:COMPETES_WITH]->()
                    WHERE id(r) = $edge_id
                    SET r.embedding_vector = $embedding,
                        r.embedding_updated_at = $updated_at,
                        r.embedding_model = $model
                """
                tx.run(query,
                    edge_id=int(update["edge_id"]),
                    embedding=update["embedding"],
                    updated_at=update["updated_at"],
                    model=update["model"]
                )

        with self.driver.session() as session:
            session.execute_write(_update_batch, updates)

    def get_edge_embedding_stats(self, edge_type: str) -> Dict:
        """Holt Statistiken über Edge-Embeddings."""
        with self.driver.session() as session:
            # Get total count
            total_result = session.run(f"MATCH ()-[r:{edge_type}]->() RETURN count(r) AS total")
            total = total_result.single()["total"]

            # Get count with embeddings
            emb_result = session.run(f"MATCH ()-[r:{edge_type}]->() WHERE r.embedding_vector IS NOT NULL RETURN count(r) AS cnt")
            with_emb = emb_result.single()["cnt"]

            return {
                "total": total,
                "with_embedding": with_emb,
                "without_embedding": total - with_emb
            }


class EmbeddingGenerator:
    """Generiert Embeddings mit OpenAI."""

    def __init__(self, api_key: str):
        self.client = OpenAI(api_key=api_key)
        logger.info(f"OpenAI Client initialisiert (Modell: {EMBEDDING_MODEL})")

    def generate_embeddings(self, texts: List[str]) -> List[List[float]]:
        """Generiert Embeddings für eine Liste von Texten."""
        if not texts:
            return []

        response = self.client.embeddings.create(
            model=EMBEDDING_MODEL,
            input=texts
        )

        # Embeddings in der richtigen Reihenfolge zurückgeben
        embeddings = [item.embedding for item in response.data]
        return embeddings


def process_items(
    db: MemgraphConnection,
    generator: EmbeddingGenerator,
    items: List[GearItem],
    batch_size: int = BATCH_SIZE_DB,
    dry_run: bool = False
) -> int:
    """Verarbeitet alle Items in Batches."""

    total_processed = 0
    total_errors = 0

    # Progress Bar
    pbar = tqdm(total=len(items), desc="Generiere Embeddings")

    for i in range(0, len(items), batch_size):
        batch = items[i:i + batch_size]

        try:
            # Texte für Embedding vorbereiten
            texts = [item.to_embedding_text() for item in batch]

            if dry_run:
                logger.info(f"[DRY RUN] Würde {len(batch)} Embeddings generieren")
                for item in batch[:3]:  # Zeige erste 3 Beispiele
                    logger.info(f"  - {item.gear_id}: {item.to_embedding_text()[:80]}...")
                pbar.update(len(batch))
                continue

            # Embeddings generieren
            embeddings = generator.generate_embeddings(texts)

            # Updates vorbereiten
            timestamp = datetime.utcnow().isoformat()
            updates = [
                {
                    "gear_id": item.gear_id,
                    "embedding": embedding,
                    "updated_at": timestamp,
                    "model": EMBEDDING_MODEL
                }
                for item, embedding in zip(batch, embeddings)
            ]

            # In DB speichern
            db.update_embeddings(updates)
            total_processed += len(batch)

            pbar.update(len(batch))

        except Exception as e:
            logger.error(f"Fehler bei Batch {i}-{i+batch_size}: {e}")
            total_errors += len(batch)
            pbar.update(len(batch))
            continue

    pbar.close()

    logger.info(f"Abgeschlossen: {total_processed} erfolgreich, {total_errors} Fehler")
    return total_processed


def process_insights(
    db: MemgraphConnection,
    generator: EmbeddingGenerator,
    items: List[EmbeddableNode],
    batch_size: int = BATCH_SIZE_DB,
    dry_run: bool = False
) -> int:
    """Verarbeitet Insight Nodes in Batches."""

    total_processed = 0
    total_errors = 0

    pbar = tqdm(total=len(items), desc="Generiere Insight Embeddings")

    for i in range(0, len(items), batch_size):
        batch = items[i:i + batch_size]

        try:
            texts = [item.to_embedding_text() for item in batch]

            if dry_run:
                logger.info(f"[DRY RUN] Würde {len(batch)} Insight Embeddings generieren")
                for item in batch[:3]:
                    logger.info(f"  - {item.node_id}: {item.to_embedding_text()[:80]}...")
                pbar.update(len(batch))
                continue

            embeddings = generator.generate_embeddings(texts)

            timestamp = datetime.utcnow().isoformat()
            updates = [
                {
                    "node_id": item.node_id,
                    "embedding": embedding,
                    "updated_at": timestamp,
                    "model": EMBEDDING_MODEL
                }
                for item, embedding in zip(batch, embeddings)
            ]

            db.update_insight_embeddings(updates)
            total_processed += len(batch)

            pbar.update(len(batch))

        except Exception as e:
            logger.error(f"Fehler bei Batch {i}-{i+batch_size}: {e}")
            total_errors += len(batch)
            pbar.update(len(batch))
            continue

    pbar.close()

    logger.info(f"Abgeschlossen: {total_processed} erfolgreich, {total_errors} Fehler")
    return total_processed


def process_glossary(
    db: MemgraphConnection,
    generator: EmbeddingGenerator,
    items: List[EmbeddableNode],
    batch_size: int = BATCH_SIZE_DB,
    dry_run: bool = False
) -> int:
    """Verarbeitet GlossaryTerm Nodes in Batches."""

    total_processed = 0
    total_errors = 0

    pbar = tqdm(total=len(items), desc="Generiere GlossaryTerm Embeddings")

    for i in range(0, len(items), batch_size):
        batch = items[i:i + batch_size]

        try:
            texts = [item.to_embedding_text() for item in batch]

            if dry_run:
                logger.info(f"[DRY RUN] Würde {len(batch)} GlossaryTerm Embeddings generieren")
                for item in batch[:3]:
                    logger.info(f"  - {item.node_id}: {item.to_embedding_text()[:80]}...")
                pbar.update(len(batch))
                continue

            embeddings = generator.generate_embeddings(texts)

            timestamp = datetime.utcnow().isoformat()
            updates = [
                {
                    "node_id": item.node_id,
                    "embedding": embedding,
                    "updated_at": timestamp,
                    "model": EMBEDDING_MODEL
                }
                for item, embedding in zip(batch, embeddings)
            ]

            db.update_glossary_embeddings(updates)
            total_processed += len(batch)

            pbar.update(len(batch))

        except Exception as e:
            logger.error(f"Fehler bei Batch {i}-{i+batch_size}: {e}")
            total_errors += len(batch)
            pbar.update(len(batch))
            continue

    pbar.close()

    logger.info(f"Abgeschlossen: {total_processed} erfolgreich, {total_errors} Fehler")
    return total_processed


def process_edges(
    db: MemgraphConnection,
    generator: EmbeddingGenerator,
    items: List[EmbeddableEdge],
    edge_type: str,
    batch_size: int = BATCH_SIZE_DB,
    dry_run: bool = False
) -> int:
    """Verarbeitet Edge Embeddings in Batches."""

    total_processed = 0
    total_errors = 0

    pbar = tqdm(total=len(items), desc=f"Generiere {edge_type} Embeddings")

    for i in range(0, len(items), batch_size):
        batch = items[i:i + batch_size]

        try:
            texts = [item.to_embedding_text() for item in batch]

            if dry_run:
                logger.info(f"[DRY RUN] Würde {len(batch)} {edge_type} Embeddings generieren")
                for item in batch[:3]:
                    logger.info(f"  - {item.edge_id}: {item.to_embedding_text()[:80]}...")
                pbar.update(len(batch))
                continue

            embeddings = generator.generate_embeddings(texts)

            timestamp = datetime.utcnow().isoformat()
            updates = [
                {
                    "edge_id": item.edge_id,
                    "embedding": embedding,
                    "updated_at": timestamp,
                    "model": EMBEDDING_MODEL
                }
                for item, embedding in zip(batch, embeddings)
            ]

            if edge_type == "SUITABLE_FOR":
                db.update_suitable_for_embeddings(updates)
            else:  # COMPETES_WITH
                db.update_competes_with_embeddings(updates)

            total_processed += len(batch)

            pbar.update(len(batch))

        except Exception as e:
            logger.error(f"Fehler bei Batch {i}-{i+batch_size}: {e}")
            total_errors += len(batch)
            pbar.update(len(batch))
            continue

    pbar.close()

    logger.info(f"Abgeschlossen: {total_processed} erfolgreich, {total_errors} Fehler")
    return total_processed


def main():
    parser = argparse.ArgumentParser(description="GearGraph Embedding Generator")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE_DB,
                        help=f"Batch-Größe für DB-Updates (default: {BATCH_SIZE_DB})")
    parser.add_argument("--limit", type=int, default=None,
                        help="Maximale Anzahl zu verarbeitender Items")
    parser.add_argument("--dry-run", action="store_true",
                        help="Nur simulieren, keine Änderungen")
    parser.add_argument("--stats-only", action="store_true",
                        help="Nur Statistiken anzeigen")
    parser.add_argument("--node-type", type=str, default="GearItem",
                        choices=["GearItem", "Insight", "GlossaryTerm", "SUITABLE_FOR", "COMPETES_WITH", "all", "all-nodes", "all-edges"],
                        help="Node/Edge-Typ für Embeddings (default: GearItem)")
    args = parser.parse_args()

    # Environment laden (aus .env oder Umgebung)
    load_dotenv()

    # Konfiguration aus Environment
    openai_key = os.getenv("OPENAI_API_KEY")
    if not openai_key and not args.stats_only:
        logger.error("OPENAI_API_KEY nicht gesetzt!")
        sys.exit(1)

    # Memgraph Konfiguration - Default für Server
    memgraph_host = os.getenv("MEMGRAPH_HOST", "localhost")
    memgraph_port = int(os.getenv("MEMGRAPH_PORT", "7687"))
    memgraph_user = os.getenv("MEMGRAPH_USER", "memgraph")
    memgraph_password = os.getenv("MEMGRAPH_PASSWORD", "geargraph2025")

    logger.info(f"Verbinde zu Memgraph: {memgraph_host}:{memgraph_port}")

    # Verbindung aufbauen
    db = MemgraphConnection(memgraph_host, memgraph_port, memgraph_user, memgraph_password)

    try:
        # Verbindung prüfen
        if not db.verify_connection():
            logger.error("Kann keine Verbindung zu Memgraph herstellen!")
            sys.exit(1)

        # Determine which types to process
        all_nodes = ["GearItem", "Insight", "GlossaryTerm"]
        all_edges = ["SUITABLE_FOR", "COMPETES_WITH"]

        if args.node_type == "all":
            types_to_process = all_nodes + all_edges
        elif args.node_type == "all-nodes":
            types_to_process = all_nodes
        elif args.node_type == "all-edges":
            types_to_process = all_edges
        else:
            types_to_process = [args.node_type]

        for item_type in types_to_process:
            is_edge = item_type in all_edges
            logger.info(f"")
            logger.info(f"{'=' * 40}")
            logger.info(f"Verarbeite: {item_type}")
            logger.info(f"{'=' * 40}")

            # Statistiken anzeigen
            if is_edge:
                stats = db.get_edge_embedding_stats(item_type)
                type_label = f"{item_type} Edges"
            else:
                stats = db.get_embedding_stats(item_type)
                type_label = f"{item_type} Nodes"

            logger.info(f"")
            logger.info(f"=== {item_type} Embedding Status ===")
            logger.info(f"Gesamt {item_type}:     {stats['total']:,}")
            logger.info(f"Mit Embedding:        {stats['with_embedding']:,}")
            logger.info(f"Ohne Embedding:       {stats['without_embedding']:,}")
            if stats['total'] > 0:
                coverage = (stats['with_embedding'] / stats['total']) * 100
                logger.info(f"Aktuelle Abdeckung:   {coverage:.1f}%")
            logger.info(f"{'=' * (len(item_type) + 24)}")
            logger.info(f"")

            if args.stats_only:
                continue

            if stats['without_embedding'] == 0:
                logger.info(f"Alle {type_label} haben bereits Embeddings!")
                continue

            # Items laden
            if item_type == "GearItem":
                items = db.get_items_without_embeddings(limit=args.limit)
            elif item_type == "Insight":
                items = db.get_insights_without_embeddings(limit=args.limit)
            elif item_type == "GlossaryTerm":
                items = db.get_glossary_without_embeddings(limit=args.limit)
            elif item_type == "SUITABLE_FOR":
                items = db.get_suitable_for_without_embeddings(limit=args.limit)
            elif item_type == "COMPETES_WITH":
                items = db.get_competes_with_without_embeddings(limit=args.limit)

            if not items:
                logger.info("Keine Items zu verarbeiten.")
                continue

            # Embedding Generator
            generator = EmbeddingGenerator(openai_key)

            # Kosten schätzen
            # text-embedding-3-small: $0.02 / 1M tokens
            # Durchschnittlich ~100 tokens pro GearItem, ~200 für Insights/Edges
            tokens_per_item = 200 if item_type in ["Insight", "SUITABLE_FOR", "COMPETES_WITH"] else 100
            estimated_tokens = len(items) * tokens_per_item
            estimated_cost = (estimated_tokens / 1_000_000) * 0.02
            logger.info(f"Zu verarbeiten:     {len(items):,} {type_label}")
            logger.info(f"Geschätzte Tokens:  {estimated_tokens:,}")
            logger.info(f"Geschätzte Kosten:  ${estimated_cost:.4f}")
            logger.info(f"")

            if args.dry_run:
                logger.info("[DRY RUN] Keine Änderungen werden vorgenommen")
                logger.info("")

            # Verarbeitung starten
            if item_type == "GearItem":
                processed = process_items(
                    db=db,
                    generator=generator,
                    items=items,
                    batch_size=args.batch_size,
                    dry_run=args.dry_run
                )
            elif item_type == "Insight":
                processed = process_insights(
                    db=db,
                    generator=generator,
                    items=items,
                    batch_size=args.batch_size,
                    dry_run=args.dry_run
                )
            elif item_type == "GlossaryTerm":
                processed = process_glossary(
                    db=db,
                    generator=generator,
                    items=items,
                    batch_size=args.batch_size,
                    dry_run=args.dry_run
                )
            elif item_type in ["SUITABLE_FOR", "COMPETES_WITH"]:
                processed = process_edges(
                    db=db,
                    generator=generator,
                    items=items,
                    edge_type=item_type,
                    batch_size=args.batch_size,
                    dry_run=args.dry_run
                )

            # Finale Stats
            if not args.dry_run:
                logger.info("")
                if is_edge:
                    final_stats = db.get_edge_embedding_stats(item_type)
                else:
                    final_stats = db.get_embedding_stats(item_type)
                logger.info(f"=== {item_type} Finale Statistiken ===")
                logger.info(f"Mit Embedding:   {final_stats['with_embedding']:,} / {final_stats['total']:,}")
                coverage = (final_stats['with_embedding'] / final_stats['total']) * 100
                logger.info(f"Abdeckung:       {coverage:.1f}%")
                logger.info(f"{'=' * (len(item_type) + 26)}")

    finally:
        db.close()


if __name__ == "__main__":
    main()
