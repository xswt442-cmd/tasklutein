"""Database engine and request-scoped sessions.

The engine is intentionally lazy so importing the app in tests does not require
production credentials. Database schema is provisioned via migrations SQL.
"""
import os
from collections.abc import Iterator
from functools import lru_cache

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker


@lru_cache(maxsize=1)
def get_session_factory() -> sessionmaker[Session]:
    url = os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not configured")
    engine = create_engine(url, pool_pre_ping=True)
    return sessionmaker(bind=engine, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    session = get_session_factory()()
    try:
        yield session
    finally:
        session.close()
