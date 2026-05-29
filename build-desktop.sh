cd frontend \
    && bun run build \
    && cd .. \
    && cargo build \
    --release --package crow-ui-server \
    --bin crow-ui-server \
    -j \
    && cd electron \
    && bun run build \
    && cd ..
