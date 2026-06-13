FROM apify/actor-python:3.12

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY . ./
RUN python3 -m compileall -q .

CMD ["python3", "-m", "src"]
