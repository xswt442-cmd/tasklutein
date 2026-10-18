"""Database engine and request-scoped sessions.

The engine is intentionally lazy so importing the app in tests does not require
production credentials. Database schema is provisioned via migrations SQL.
"""
import os
from collections.abc import Iterator
from functools import lru_cache

from sqlalchemy import create_engine, event
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker


@lru_cache(maxsize=1)
def get_session_factory() -> sessionmaker[Session]:
    url = os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not configured")
    backend = make_url(url).get_backend_name()
    engine_options = {"pool_pre_ping": True}
    if backend == "postgresql":
        engine_options.update({
            "connect_args": {
                "connect_timeout": 3,
                "options": "-c statement_timeout=3000",
            },
            "pool_timeout": 3,
        })
    engine = create_engine(url, **engine_options)
    if backend == "sqlite":
        @event.listens_for(engine, "connect")
        def enable_sqlite_foreign_keys(connection, _record):
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return sessionmaker(bind=engine, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    session = get_session_factory()()
    try:
        yield session
    finally:
        session.close()
