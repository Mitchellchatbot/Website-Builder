# Official Playwright image — Python + Chromium + all system deps preinstalled.
FROM mcr.microsoft.com/playwright/python:v1.49.1-jammy

WORKDIR /app

# Install Python deps first for better layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the backend.
COPY . .

# Railway injects $PORT at runtime.
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
