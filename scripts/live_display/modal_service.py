"""Private on-demand StreamDiffusion GPU worker. No public inference endpoint.

Deploy with the Modal CLI; credentials stay in the controlling process.
A single L4 scales to zero after 15 idle seconds. No persistent volume.
"""
import base64
from io import BytesIO
import json
from pathlib import Path
import time
import modal

APP_NAME = 'rose-live-display-streamdiffusion'
UPSTREAM_COMMIT = 'b623251dc055e1fd858d53509aa43e09dfc5cdc0'
MODEL = 'stabilityai/sd-turbo'

image = (
    modal.Image.debian_slim(python_version='3.10')
    .apt_install('git', 'libgl1', 'libglib2.0-0')
    .pip_install('torch==2.1.0', 'torchvision==0.16.0', 'numpy==1.26.4',
                 'diffusers==0.24.0', 'transformers==4.35.2', 'accelerate==0.24.1',
                 'huggingface_hub==0.19.4', 'safetensors==0.4.5', 'Pillow==10.4.0',
                 f'git+https://github.com/cumulo-autumn/StreamDiffusion.git@{UPSTREAM_COMMIT}')
)
app = modal.App(APP_NAME)


@app.cls(image=image, gpu='L4', cpu=2, memory=8192, min_containers=0,
         max_containers=1, scaledown_window=15, timeout=120, startup_timeout=300,
         retries=0)
class StreamWorker:
    @modal.enter()
    def load(self):
        import torch
        from diffusers import AutoencoderTiny, StableDiffusionPipeline
        from streamdiffusion import StreamDiffusion
        if not torch.cuda.is_available():
            raise RuntimeError('A CUDA GPU is required; refusing CPU fallback')
        pipe = StableDiffusionPipeline.from_pretrained(MODEL, torch_dtype=torch.float16,
                                                       variant='fp16').to('cuda')
        self.stream = StreamDiffusion(pipe, t_index_list=[0], torch_dtype=torch.float16,
                                      cfg_type='none', frame_buffer_size=1, width=512, height=512)
        self.stream.vae = AutoencoderTiny.from_pretrained('madebyollin/taesd').to(device='cuda', dtype=torch.float16)
        self.stream.prepare('precision watch', num_inference_steps=50, guidance_scale=1.0,
                            generator=torch.manual_seed(2), seed=2)
        self.device = torch.cuda.get_device_name(0)
        self.prompt = 'precision watch'

    @modal.method()
    def predict(self, prompt: str):
        import torch
        from streamdiffusion.image_utils import postprocess_image
        if not isinstance(prompt, str) or not 1 <= len(prompt) <= 2000:
            raise ValueError('Prompt must have 1–2000 characters')
        started = time.monotonic()
        with torch.inference_mode():
            if self.prompt != prompt:
                self.stream.update_prompt(prompt)
                self.prompt = prompt
            pixels = self.stream.txt2img_sd_turbo(1)
            picture = postprocess_image(pixels, output_type='pil')[0]
        output = BytesIO()
        picture.convert('RGB').save(output, format='JPEG', quality=90)
        return {'base64_image': base64.b64encode(output.getvalue()).decode(),
                'device': self.device, 'inference_seconds': time.monotonic() - started,
                'model': MODEL, 'upstream_commit': UPSTREAM_COMMIT}


@app.local_entrypoint()
def proof(output: str = '/tmp/rose-streamdiffusion-proof.jpg'):
    started = time.monotonic()
    result = StreamWorker().predict.remote('A detailed luxury mechanical wristwatch, brushed titanium case, sapphire glass, macro studio photography, crisp dial, black background')
    destination = Path(output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(base64.b64decode(result.pop('base64_image')))
    print(json.dumps({**result, 'elapsed_seconds': time.monotonic() - started, 'output': str(destination)}))
