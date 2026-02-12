"""Modal GPU backend for GEPA reward model training and inference.

All heavy compute (model loading, training, scoring) runs on Modal GPUs.
Data preparation and serialization happen locally via critic.py.

Usage:
    from research.gepa.critic import prepare_reward_pairs, serialize_prompt, serialize_candidate
    from research.gepa.modal_critic import train, score

    rows = prepare_reward_pairs()                       # local serialization
    result = train.remote(rows)                         # GPU training
    scores = score.remote(conversations, result["model_id"])  # GPU inference
"""

import modal

app = modal.App('gepa-critic')

image = (
    modal.Image.debian_slim(python_version='3.11')
    .pip_install(
        'torch',
        'transformers',
        'trl',
        'peft',
        'datasets',
        'accelerate',
        'bitsandbytes',
    )
)

vol = modal.Volume.from_name('gepa-models', create_if_missing=True)
hf_secret = modal.Secret.from_name('huggingface-secret')
MODEL_DIR = '/models'


@app.function(
    gpu='A10G',
    image=image,
    volumes={MODEL_DIR: vol},
    secrets=[hf_secret],
    timeout=3600,
)
def train(
    rows: dict,
    base_model: str = 'google/gemma-2-9b-it',
    model_id: str = 'reward_model',
    lora_r: int = 16,
    learning_rate: float = 1e-3,
    num_epochs: int = 1,
    per_device_batch_size: int = 2,
    max_length: int = 3072,
) -> dict:
    """Train reward model on GPU. Returns training metrics.

    Args:
        rows: dict with keys 'prompt', 'chosen', 'rejected' — each a list
              of conversation messages in trl format. All serialization is
              done by the caller (critic.py prepare_reward_pairs).
        base_model: HuggingFace model ID.
        model_id: Name for saved model (stored under /models/{model_id}).

    Returns:
        dict with 'model_id', 'num_examples', 'train_loss', 'metrics'.
    """
    import os
    import datasets
    from huggingface_hub import login
    from peft import LoraConfig, TaskType
    from transformers import (
        AutoModelForSequenceClassification,
        AutoTokenizer,
        BitsAndBytesConfig,
    )
    from trl import RewardConfig, RewardTrainer
    import torch

    if os.environ.get('HF_TOKEN'):
        login(token=os.environ['HF_TOKEN'])

    output_dir = f'{MODEL_DIR}/{model_id}'
    dataset = datasets.Dataset.from_dict(rows)

    print(f'Training on {len(dataset)} examples, base_model={base_model}')

    quantization_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type='nf4',
        bnb_4bit_compute_dtype=torch.bfloat16,
    )

    model = AutoModelForSequenceClassification.from_pretrained(
        base_model,
        num_labels=1,
        quantization_config=quantization_config,
        device_map='auto',
    )

    tokenizer = AutoTokenizer.from_pretrained(base_model)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        model.config.pad_token_id = tokenizer.pad_token_id

    peft_config = LoraConfig(
        task_type=TaskType.SEQ_CLS,
        r=lora_r,
        lora_alpha=lora_r * 2,
        lora_dropout=0.05,
        target_modules=['q_proj', 'v_proj'],
        modules_to_save=['score'],
    )

    training_args = RewardConfig(
        output_dir=output_dir,
        num_train_epochs=num_epochs,
        per_device_train_batch_size=per_device_batch_size,
        learning_rate=learning_rate,
        max_length=max_length,
        logging_steps=1,
        save_strategy='epoch',
        remove_unused_columns=False,
        center_rewards_coefficient=0.01,
    )

    trainer = RewardTrainer(
        model=model,
        args=training_args,
        processing_class=tokenizer,
        train_dataset=dataset,
        peft_config=peft_config,
    )

    result = trainer.train()
    trainer.save_model(output_dir)
    tokenizer.save_pretrained(output_dir)

    vol.commit()

    metrics = result.metrics
    print(f'Training complete: loss={metrics.get("train_loss", "N/A")}')

    return {
        'model_id': model_id,
        'num_examples': len(dataset),
        'train_loss': metrics.get('train_loss'),
        'metrics': metrics,
    }


SCORER_MODEL_ID = 'gepa_critic_312'


@app.cls(
    gpu='A10G',
    image=image,
    volumes={MODEL_DIR: vol},
    secrets=[hf_secret],
    timeout=600,
    min_containers=1,
)
class Scorer:
    @modal.enter()
    def load_model(self):
        import os
        import torch
        from huggingface_hub import login
        from peft import AutoPeftModelForSequenceClassification
        from transformers import AutoTokenizer, BitsAndBytesConfig

        if os.environ.get('HF_TOKEN'):
            login(token=os.environ['HF_TOKEN'])

        model_dir = f'{MODEL_DIR}/{SCORER_MODEL_ID}'
        vol.reload()
        print(f'Loading model {SCORER_MODEL_ID} from {model_dir} (4-bit)...')
        quantization_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type='nf4',
            bnb_4bit_compute_dtype=torch.bfloat16,
        )
        self.model = AutoPeftModelForSequenceClassification.from_pretrained(
            model_dir, num_labels=1,
            quantization_config=quantization_config,
            device_map='auto',
        )
        self.tokenizer = AutoTokenizer.from_pretrained(model_dir)
        self.model.eval()
        print(f'Model {SCORER_MODEL_ID} loaded on {self.model.device}.')

    @modal.method()
    def score(self, conversations: list[list[dict]]) -> list[float]:
        """Score pre-serialized conversations on GPU."""
        import torch

        scores = []
        for conv in conversations:
            inputs = self.tokenizer.apply_chat_template(
                conv,
                return_tensors='pt',
                tokenize=True,
                return_dict=True,
            ).to(self.model.device)

            with torch.no_grad():
                outputs = self.model(**inputs)

            scores.append(outputs.logits[0, 0].item())

        return scores
