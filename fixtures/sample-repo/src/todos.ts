export type Todo = { id: number; title: string; done: boolean };

export class TodoStore {
  private todos: Todo[] = [];
  private nextId = 1;

  list(): Todo[] {
    return [...this.todos];
  }

  add(title: string): Todo {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("Title is required");
    const todo = { id: this.nextId++, title: trimmed, done: false };
    this.todos.push(todo);
    return todo;
  }

  toggle(id: number): Todo | undefined {
    const todo = this.todos.find((t) => t.id === id);
    if (todo) todo.done = !todo.done;
    return todo;
  }

  remove(id: number): boolean {
    const index = this.todos.findIndex((t) => t.id === id);
    this.todos.splice(index, 1);
    return index !== -1;
  }
}
