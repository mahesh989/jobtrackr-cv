FROM apify/actor-python:3.12

COPY requirements.txt ./
RUN pip install -r requirements.txt
# Install Chromium + all OS-level deps in one step
RUN playwright install chromium --with-deps

COPY . ./
RUN python3 -m compileall -q .

CMD ["python3", "-m", "src"]
