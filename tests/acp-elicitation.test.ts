/** Offline unit coverage for ACP form elicitation mapping (`elicitation/create` <-> question card). */
import type * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { buildAcpElicitationResponse, planAcpFormElicitation } from '../src/main/harness/acp-elicitation';

function antigravityQuestionRequest(): acp.CreateElicitationRequest {
  return {
    sessionId: 'sess-1',
    toolCallId: 'call-ask-1',
    mode: 'form',
    message: 'The agent has 2 questions.',
    requestedSchema: {
      type: 'object',
      properties: {
        q1: {
          type: 'string',
          title: 'Pick a color',
          oneOf: [
            { const: '1', title: 'Red' },
            { const: '2', title: 'Blue', description: 'Calm and cool' }
          ]
        },
        q1_other: {
          type: 'string',
          title: 'Other',
          description: 'Optional free-form answer to: Pick a color'
        },
        q2: {
          type: 'array',
          title: 'Pick fruits',
          items: {
            anyOf: [
              { const: '1', title: 'Apple' },
              { const: '2', title: 'Banana' }
            ]
          }
        },
        q2_other: {
          type: 'string',
          title: 'Other',
          description: 'Optional free-form answer to: Pick fruits'
        }
      }
    }
  };
}

describe('ACP form elicitation mapping', () => {
  it('folds Antigravity single-select and multi-select questions with companion _other fields into one question card', () => {
    const plan = planAcpFormElicitation(antigravityQuestionRequest(), 'Antigravity');
    expect(plan).not.toBeNull();
    expect(plan?.description).toBeUndefined();
    expect(plan).toMatchObject({
      title: 'Antigravity has 2 questions',
      toolItemId: 'call-ask-1',
      supportsQuestionComment: true,
      questions: [
        {
          id: 'q1',
          question: 'Pick a color',
          options: [{ label: 'Red' }, { label: 'Blue', description: 'Calm and cool' }],
          allowOther: true
        },
        {
          id: 'q2',
          question: 'Pick fruits',
          options: [{ label: 'Apple' }, { label: 'Banana' }],
          allowOther: true,
          multiSelect: true
        }
      ]
    });
  });

  it('maps selected single-select and multi-select option labels back to wire const values', () => {
    const plan = planAcpFormElicitation(antigravityQuestionRequest(), 'Antigravity')!;
    expect(buildAcpElicitationResponse(plan, {
      optionId: 'allow',
      answers: { q1: 'Blue' },
      multiAnswers: { q2: ['Apple', 'Banana'] }
    })).toEqual({
      action: 'accept',
      content: { q1: '2', q2: ['1', '2'] }
    });
  });

  it('routes typed custom answers to companion _other fields and preserves multi-select combinations', () => {
    const plan = planAcpFormElicitation(antigravityQuestionRequest(), 'Antigravity')!;
    expect(buildAcpElicitationResponse(plan, {
      optionId: 'allow',
      answers: { q1: 'Teal', q2: 'Mango' },
      multiAnswers: { q2: ['Apple'] }
    })).toEqual({
      action: 'accept',
      content: { q1_other: 'Teal', q2: ['1'], q2_other: 'Mango' }
    });
  });

  it('delivers optional card-level context via the companion _other field alongside or without selections', () => {
    const plan = planAcpFormElicitation(antigravityQuestionRequest(), 'Antigravity')!;

    // Combined with chosen options.
    expect(buildAcpElicitationResponse(plan, {
      optionId: 'allow',
      answers: { q1: 'Red' },
      multiAnswers: { q2: ['Banana'] },
      note: 'Organic only.'
    })).toEqual({
      action: 'accept',
      content: { q1: '1', q2: ['2'], q2_other: 'Additional context: Organic only.' }
    });

    // Combined with an already typed _other value.
    expect(buildAcpElicitationResponse(plan, {
      optionId: 'allow',
      answers: { q1: 'Red', q2: 'Mango' },
      note: 'Prefer ripe ones.'
    })).toEqual({
      action: 'accept',
      content: { q1: '1', q2_other: 'Mango\n\nAdditional context: Prefer ripe ones.' }
    });

    // Note-only answer with no options selected.
    expect(buildAcpElicitationResponse(plan, {
      optionId: 'allow',
      answers: {},
      multiAnswers: {},
      note: 'Skip colors and pick defaults.'
    })).toEqual({
      action: 'accept',
      content: { q2_other: 'Skip colors and pick defaults.' }
    });
  });

  it('declines on Skip without leaking stale selections or typed text', () => {
    const plan = planAcpFormElicitation(antigravityQuestionRequest(), 'Antigravity')!;
    expect(buildAcpElicitationResponse(plan, {
      optionId: 'deny',
      answers: { q1: 'Red' },
      multiAnswers: { q2: ['Apple'] },
      note: 'Ask later.'
    })).toEqual({ action: 'decline' });
  });

  it('maps generic ACP form fields (enum, array enum, text, boolean, number, integer) and hides unsupported comment fields', () => {
    const request: acp.CreateElicitationRequest = {
      sessionId: 'sess-1',
      mode: 'form',
      message: 'Configure deployment parameters',
      requestedSchema: {
        type: 'object',
        title: 'Deployment settings',
        properties: {
          env: { type: 'string', title: 'Environment', description: 'Target environment', enum: ['staging', 'prod'] },
          regions: { type: 'array', title: 'Regions', items: { type: 'string', enum: ['us-east', 'eu-west'] } },
          tag: { type: 'string', title: 'Release tag' },
          dryRun: { type: 'boolean', title: 'Dry run?' },
          retries: { type: 'integer', title: 'Retries' },
          timeoutSec: { type: 'number', title: 'Timeout (s)' }
        }
      }
    };
    const plan = planAcpFormElicitation(request, 'Test Agent')!;
    expect(plan).toMatchObject({
      title: 'Deployment settings',
      description: 'Configure deployment parameters',
      supportsQuestionComment: false
    });
    expect(plan.questions).toEqual([
      { id: 'env', header: 'Environment', question: 'Target environment', options: [{ label: 'staging' }, { label: 'prod' }], allowOther: false },
      { id: 'regions', question: 'Regions', options: [{ label: 'us-east' }, { label: 'eu-west' }], allowOther: false, multiSelect: true },
      { id: 'tag', question: 'Release tag', allowOther: true },
      { id: 'dryRun', question: 'Dry run?', options: [{ label: 'Yes' }, { label: 'No' }], allowOther: false },
      { id: 'retries', question: 'Retries', allowOther: true },
      { id: 'timeoutSec', question: 'Timeout (s)', allowOther: true }
    ]);

    expect(buildAcpElicitationResponse(plan, {
      optionId: 'allow',
      answers: { env: 'staging', tag: 'v1.2.3', dryRun: 'Yes', retries: '3', timeoutSec: '1.5' },
      multiAnswers: { regions: ['us-east', 'eu-west'] },
      note: 'ignored because supportsQuestionComment is false'
    })).toEqual({
      action: 'accept',
      content: { env: 'staging', regions: ['us-east', 'eu-west'], tag: 'v1.2.3', dryRun: true, retries: 3, timeoutSec: 1.5 }
    });

    // Non-integer value for an integer field is omitted rather than violating schema type.
    expect(buildAcpElicitationResponse(plan, {
      optionId: 'allow',
      answers: { retries: '2.5', timeoutSec: 'not-a-number', dryRun: 'No' }
    })).toEqual({
      action: 'accept',
      content: { dryRun: false }
    });
  });

  it('disambiguates duplicate option titles so const lookup remains exact', () => {
    const plan = planAcpFormElicitation({
      sessionId: 'sess-1',
      mode: 'form',
      message: 'Pick one',
      requestedSchema: {
        type: 'object',
        properties: {
          q1: {
            type: 'string',
            title: 'Choice',
            oneOf: [
              { const: 'a', title: 'Same' },
              { const: 'b', title: 'Same' }
            ]
          }
        }
      }
    }, 'Antigravity')!;
    expect(plan.questions[0]!.options?.map((o) => o.label)).toEqual(['Same', 'Same (b)']);
    expect(buildAcpElicitationResponse(plan, { optionId: 'allow', answers: { q1: 'Same (b)' } })).toEqual({
      action: 'accept',
      content: { q1: 'b' }
    });
  });

  it('rejects non-form modes, empty schemas, and required custom schema types', () => {
    expect(planAcpFormElicitation({
      sessionId: 'sess-1',
      mode: 'url',
      elicitationId: 'e1',
      url: 'https://example.com',
      message: 'Open URL'
    }, 'Antigravity')).toBeNull();

    expect(planAcpFormElicitation({
      sessionId: 'sess-1',
      mode: 'form',
      message: 'Empty',
      requestedSchema: { type: 'object', properties: {} }
    }, 'Antigravity')).toBeNull();

    // Required unknown type -> decline whole form rather than sending an invalid response.
    expect(planAcpFormElicitation({
      sessionId: 'sess-1',
      mode: 'form',
      message: 'Custom required',
      requestedSchema: {
        type: 'object',
        required: ['custom'],
        properties: {
          custom: { type: '_vendor_picker' },
          q1: { type: 'string', title: 'Fallback' }
        }
      }
    }, 'Antigravity')).toBeNull();

    // Optional unknown type -> skipped while supported fields still render.
    const partial = planAcpFormElicitation({
      sessionId: 'sess-1',
      mode: 'form',
      message: 'Custom optional',
      requestedSchema: {
        type: 'object',
        properties: {
          custom: { type: '_vendor_picker' },
          q1: { type: 'string', title: 'Notes' }
        }
      }
    }, 'Antigravity');
    expect(partial?.questions.map((q) => q.id)).toEqual(['q1']);
  });
});
