const taskParser = require('../modules/task-parser');

describe('task-parser', () => {
  test('splits bullet list into subtasks', () => {
    const input = '- Build UI\n- Fix backend bug\n- Review PR';
    const result = taskParser.parseTaskInput(input);
    expect(result.success).toBe(true);
    expect(result.subtasks.length).toBe(3);
    expect(result.subtasks[0].text).toMatch(/Build UI/i);
  });

  test('detects ambiguity for vague tasks', () => {
    const result = taskParser.parseTaskInput('do some stuff');
    expect(result.ambiguity.isAmbiguous).toBe(true);
    expect(result.ambiguity.questions.length).toBeGreaterThan(0);
  });

  test('adds dependency hints when connectors present', () => {
    const result = taskParser.parseTaskInput('fix backend then update UI');
    expect(result.subtasks.length).toBeGreaterThan(1);
    expect(result.subtasks[1].dependsOn.length).toBeGreaterThan(0);
  });

  test('returns error for empty input', () => {
    const result = taskParser.parseTaskInput('');
    expect(result.success).toBe(false);
    expect(result.error).toBe('empty');
    expect(result.ambiguity.isAmbiguous).toBe(true);
    expect(result.ambiguity.reasons).toContain('Empty task');
  });

  test('returns error for whitespace-only input', () => {
    const result = taskParser.parseTaskInput('   \n  \t  ');
    expect(result.success).toBe(false);
    expect(result.error).toBe('empty');
  });

  test('handles multi-line bullet items', () => {
    // Tests lines 48-49 - continuation lines in bullet lists
    const input = '- First task that spans\n  multiple lines\n- Second task';
    const result = taskParser.parseTaskInput(input);
    expect(result.success).toBe(true);
    expect(result.subtasks.length).toBe(2);
    expect(result.subtasks[0].text).toContain('First task');
    expect(result.subtasks[0].text).toContain('multiple lines');
  });

  test('splits long text by "and" when no other delimiters', () => {
    // Tests line 68 - splitting by "and" for long text
    const longText = 'Implement the authentication module for the user login system and create the registration form with validation';
    const result = taskParser.parseTaskInput(longText);
    expect(result.success).toBe(true);
    expect(result.subtasks.length).toBeGreaterThanOrEqual(2);
  });

  test('handles numbered lists', () => {
    const input = '1. First\n2. Second\n3. Third';
    const result = taskParser.parseTaskInput(input);
    expect(result.success).toBe(true);
    expect(result.subtasks.length).toBe(3);
  });

  test('handles asterisk bullet lists', () => {
    const input = '* Task A\n* Task B';
    const result = taskParser.parseTaskInput(input);
    expect(result.success).toBe(true);
    expect(result.subtasks.length).toBe(2);
  });

  test('normalizes various connectors', () => {
    const input = 'Step one and then step two after that step three';
    const result = taskParser.parseTaskInput(input);
    expect(result.success).toBe(true);
    expect(result.subtasks.length).toBeGreaterThanOrEqual(2);
  });
});
