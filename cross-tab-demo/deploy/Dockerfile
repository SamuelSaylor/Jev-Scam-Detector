FROM python:3.12-slim

# Hugging Face Spaces runs containers as a non-root user with uid 1000.
RUN useradd -m -u 1000 user
USER user
ENV PATH="/home/user/.local/bin:$PATH"
WORKDIR /home/user/app

COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=user server.py download_model.py ./
COPY --chown=user static ./static
RUN python download_model.py && mkdir transcripts

EXPOSE 7860
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "7860"]
