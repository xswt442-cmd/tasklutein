"""Create tables in a fresh file-backed SQLite database for real UI HTTP tests."""
import sys

from app.models import Base
from sqlalchemy import create_engine, event

database_url = sys.argv[1]
engine = create_engine(database_url)


@event.listens_for(engine, "connect")
def enable_sqlite_foreign_keys(connection, _record):
    cursor = connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


Base.metadata.create_all(engine)
engine.dispose()
