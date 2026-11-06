FROM python:3.12-slim
# Optional: build with a different package index (PIP_INDEX_URL build arg).
ARG PIP_INDEX_URL
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /srv
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir ${PIP_INDEX_URL:+--index-url "$PIP_INDEX_URL"} -r requirements.txt \
    && useradd --create-home --uid 10001 appuser
COPY app ./app
COPY alembic.ini ./alembic.ini
COPY alembic ./alembic
USER appuser
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "127.0.0.1"]
