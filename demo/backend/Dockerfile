FROM registry.access.redhat.com/ubi9/python-311:latest

WORKDIR /opt/app-root/src

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

EXPOSE 7860

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
