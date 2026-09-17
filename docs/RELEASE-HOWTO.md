## How to use

1. Download **`gemma4-workstation-portable-*.zip`** and unzip it.
2. Open `gemma4-workstation.html` in **Chrome or Edge**.
3. Choose one of the two modes it offers:

   **Offline (recommended)** — click *Select assets folder* and pick the `assets` folder
   that came out of the zip. The model, the Python runtime and every package are then read
   from disk.

   **Online** — click *Stream from Hugging Face*. The model (~2.4 GB) downloads once and is
   cached by your browser, so later loads are local.

Nothing is uploaded and prompts never leave your machine.

### The zip does not contain the model

It cannot: GitHub release assets must each be under 2 GiB, and the checkpoint is 2.29 GiB
raw and still 2.02 GiB compressed — the int8 tensors are ~90% incompressible, so no
compressor closes the gap. The app streams it from the Hugging Face Hub instead.

To run **fully offline**, download
[`model.safetensors`](https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers)
and drop it into `assets/`, then use the offline option above.

### Requirements

Chrome or Edge (recent) · a GPU exposing WebGPU · ~2.5 GB free for offline use.

Verify your download against `SHA256SUMS.txt`.
