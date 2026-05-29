cd frontend \
    && bun run build \
    && cd .. \
    && cargo build \
    --release --package crow-ui-server \
    --bin crow-ui-server \
    -j 4 \
    && cd electron \
    && bun run build \
    && cd ..
