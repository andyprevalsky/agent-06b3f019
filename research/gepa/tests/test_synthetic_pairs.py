"""Unit tests for synthetic pairs judge — no API calls."""

import pytest

from research.gepa.pipelines.synthetic_pairs import (
    JudgeVerdict,
    _flip_winner,
    format_candidate_for_judge,
    format_few_shot_example,
)


class TestJudgeVerdict:

    def test_valid_verdict(self):
        v = JudgeVerdict(overall_winner='A', overall_reasoning='test', confidence=85.0)
        assert v.overall_winner == 'A'
        assert v.confidence == 85.0

    def test_tie_verdict(self):
        v = JudgeVerdict(overall_winner='TIE', overall_reasoning='close', confidence=50.0)
        assert v.overall_winner == 'TIE'

    def test_invalid_winner_rejected(self):
        with pytest.raises(Exception):
            JudgeVerdict(overall_winner='C', overall_reasoning='bad', confidence=50.0)


class TestFlipWinner:

    def test_a_to_b(self):
        assert _flip_winner('A') == 'B'

    def test_b_to_a(self):
        assert _flip_winner('B') == 'A'

    def test_tie_stays_tie(self):
        assert _flip_winner('TIE') == 'TIE'

    def test_unknown_defaults_to_tie(self):
        assert _flip_winner('INVALID') == 'TIE'


class TestFormatCandidateForJudge:

    def test_includes_label(self):
        candidate = {
            'title': 'My Plan',
            'content': 'Plan content',
            'tasks': [
                {'goal': 'Search', 'tool_name': 'web_search', 'depends_on': []},
            ],
        }
        text = format_candidate_for_judge(candidate, 'A')
        assert '## Candidate A' in text
        assert 'My Plan' in text

    def test_default_label_is_a(self):
        candidate = {'title': 'T', 'content': 'C', 'tasks': []}
        text = format_candidate_for_judge(candidate)
        assert '## Candidate A' in text


class TestFormatFewShotExample:

    def test_returns_none_when_missing_task(self):
        label = {'task_id': 'missing', 'candidate_a_idx': 0, 'candidate_b_idx': 1, 'preference': 'A', 'task_seed': 'test'}
        result = format_few_shot_example(label, {}, {})
        assert result is None

    def test_returns_none_when_candidate_out_of_range(self):
        label = {'task_id': 't1', 'candidate_a_idx': 10, 'candidate_b_idx': 1, 'preference': 'A', 'task_seed': 'test'}
        cache = {'file.json': [{'title': 'T', 'content': 'C', 'tasks': []}]}
        id_to_file = {'t1': 'file.json'}
        result = format_few_shot_example(label, cache, id_to_file)
        assert result is None

    def test_formats_valid_example(self):
        cand = {'title': 'Plan A', 'content': 'Content', 'tasks': [{'goal': 'Do X', 'tool_name': 'web_search', 'depends_on': []}]}
        label = {'task_id': 't1', 'candidate_a_idx': 0, 'candidate_b_idx': 1, 'preference': 'A', 'task_seed': 'Book flight'}
        cache = {'file.json': [cand, cand]}
        id_to_file = {'t1': 'file.json'}
        result = format_few_shot_example(label, cache, id_to_file)
        assert result is not None
        assert 'Book flight' in result
        assert 'Verdict: A' in result

    def test_returns_none_for_null_candidate(self):
        label = {'task_id': 't1', 'candidate_a_idx': 0, 'candidate_b_idx': 1, 'preference': 'A', 'task_seed': 'test'}
        cache = {'file.json': [None, {'title': 'T', 'content': 'C', 'tasks': []}]}
        id_to_file = {'t1': 'file.json'}
        result = format_few_shot_example(label, cache, id_to_file)
        assert result is None


class TestDebiasedAggregation:
    """Test the debiasing logic without calling the LLM."""

    def test_agree_returns_winner(self):
        # Simulating: AB→A, BA(flipped)→A → agree on A
        from research.gepa.pipelines.synthetic_pairs import _flip_winner
        ab_winner = 'A'
        ba_winner = 'B'  # B in flipped orientation = A in original
        ba_flipped = _flip_winner(ba_winner)
        assert ab_winner == ba_flipped  # agree
        assert ab_winner == 'A'

    def test_disagree_returns_tie(self):
        # Simulating: AB→A, BA(flipped)→B → disagree
        ab_winner = 'A'
        ba_winner = 'A'  # A in flipped orientation = B in original
        ba_flipped = _flip_winner(ba_winner)
        assert ab_winner != ba_flipped  # disagree


class TestEmbeddingIntegration:
    """Test embedding-related helpers without API calls."""

    def test_cosine_similarity_identical(self):
        from research.gepa.embeddings import cosine_similarity
        v = [1.0, 0.0, 0.0]
        assert cosine_similarity(v, v) == pytest.approx(1.0)

    def test_cosine_similarity_orthogonal(self):
        from research.gepa.embeddings import cosine_similarity
        a = [1.0, 0.0]
        b = [0.0, 1.0]
        assert cosine_similarity(a, b) == pytest.approx(0.0)

    def test_cosine_similarity_opposite(self):
        from research.gepa.embeddings import cosine_similarity
        a = [1.0, 0.0]
        b = [-1.0, 0.0]
        assert cosine_similarity(a, b) == pytest.approx(-1.0)

    def test_retrieve_similar_pairs_returns_n(self):
        from research.gepa.embeddings import retrieve_similar_pairs
        labels = [
            {'task_seed': 'Book a flight', 'preference': 'A'},
            {'task_seed': 'Order food', 'preference': 'B'},
            {'task_seed': 'Find hotels', 'preference': 'A'},
        ]
        embeddings = {
            'Buy shoes': [1.0, 0.0, 0.0],
            'Book a flight': [0.9, 0.1, 0.0],
            'Order food': [0.0, 1.0, 0.0],
            'Find hotels': [0.8, 0.2, 0.0],
        }
        result = retrieve_similar_pairs('Buy shoes', labels, embeddings, n=2)
        assert len(result) == 2
        # Most similar should be 'Book a flight' (0.9 in same direction)
        assert result[0]['task_seed'] == 'Book a flight'

    def test_embedding_cache_roundtrip(self, tmp_path):
        from research.gepa.embeddings import EmbeddingCache
        cache_path = tmp_path / 'cache.json'
        cache = EmbeddingCache(cache_path)
        cache.put('hello', [1.0, 2.0, 3.0])
        cache.save()

        cache2 = EmbeddingCache(cache_path)
        assert cache2.get('hello') == [1.0, 2.0, 3.0]
        assert cache2.has('hello')
        assert not cache2.has('world')
