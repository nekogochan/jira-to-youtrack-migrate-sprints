const fetch = require('node-fetch').default;
const luxon = require('luxon');
const config = require('./config');

// change this
const UTILS = {
  jiraDateToLuxonDateTime(date) {
    let datePart = date.split('T')[0];
    return luxon.DateTime.fromFormat(datePart, 'yyyy-MM-dd');
  },
  async loadAllFromPageable(countPerPage, pageableRequestFn) {
    const data = [];
    let offset = 0;
    while (true) {
      const dataPack = await pageableRequestFn(offset, countPerPage);
      if (dataPack.length === 0) {
        return data;
      }
      data.push(...dataPack);
      offset += countPerPage;
    }
  },
  async callAsSingleAsync(multipleAsyncFns) {
    const requests = [];
    for (const asyncFn of multipleAsyncFns) {
      requests.push(asyncFn());
    }
    await Promise.all(requests);
  },

  collectedErrors: [],
  logResponse(response, module, fnName, ...args) {
    const message = `${module}::${fnName}(${args.map(x => JSON.stringify(x)).join(', ')}); Response = ${response.status} ${response.statusText}`;
    if (response.status !== 200) {
      this.collectedErrors.push(message);
    }
    console.log(message);
  }
};

const YOUTRACK = {
  __headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.YOUTRACK_ACCESS_TOKEN}`
  },
  __logResponse(response, fnName, ...args) {
    UTILS.logResponse(response, 'YOUTRACK', fnName, args);
  },
  async __fetch(url, opts) {
    return await fetch('https://aointell.youtrack.cloud/api' + url, opts);
  },

  async createBoard({start, finish, name, description}) {
    const response = await this.__fetch(`/agiles/${config.YOUTRACK_AGILE_BOARD_ID}/sprints/?issuesQuery=&$top=-1&fields=id,agile(currentSprint(id))`, {
      method: 'POST',
      headers: this.__headers,
      body: JSON.stringify({
        isDefault: false,
        start: start,
        finish: finish,
        name: name,
        goal: description,
        moveIssuesSilently: false
      })
    });
    this.__logResponse(response, 'createBoard', start, finish, name);
    if (response.status !== 200) {
      throw await response.json();
    }
    return await response.json();
  },

  async addTasksToSprints(tasks, sprintName) {
    if (tasks.length === 0) {
      return [];
    }
    const response = await this.__fetch('/commands', {
      method: 'POST',
      headers: this.__headers,
      body: JSON.stringify({
        query: `add Board ${config.YOUTRACK_BOARD_NAME} ${sprintName}`,
        issues: tasks.map(x => {
          return {idReadable: x};
        })
      })
    });
    this.__logResponse(response, 'addTasksToSprints', tasks, sprintName);
    if (response.status !== 200) {
      console.error('error!!!');
      throw await response.json();
    }
    return await response.json();
  },

  async getAllSprints() {
    const response = await this.__fetch(`/agiles/${config.YOUTRACK_AGILE_BOARD_ID}?fields=id,name,sprints(id,name)`, {
      method: 'GET',
      headers: this.__headers
    });
    this.__logResponse(response, 'getAllSprints');
    const json = await response.json();
    // noinspection JSUnresolvedReference
    return json.sprints;
  },

  async deleteSprint(id) {
    const response = await this.__fetch(`/agiles/${config.YOUTRACK_AGILE_BOARD_ID}/sprints/${id}`, {
      method: 'DELETE',
      headers: this.__headers
    });
    this.__logResponse(response, `deleteSprint`, id);
    return await response.text();
  }
};

const JIRA = {
  __headers: {
    'Authorization': `Basic ${config.JIRA_LOGIN_TOKEN_IN_BASE64}`,
    'Accept': 'application/json'
  },
  __logResponse(response, fnName, ...args) {
    UTILS.logResponse(response, 'JIRA', fnName, args);
  },
  async __fetch(url, opts) {
    return await fetch('https://aointell.atlassian.net/rest' + url, opts);
  },

  async loadSprintsPageable(offset, count) {
    const response = await this.__fetch(`/agile/1.0/board/${config.JIRA_BOARD_ID}/sprint?startAt=${offset}&maxResults=${count}`, {
      method: 'GET',
      headers: this.__headers
    });
    this.__logResponse(response, 'loadSprints', offset, count);
    const json = await response.json();
    return json.values.map(x => {
      // noinspection JSUnresolvedReference
      return {
        id: x.id,
        name: x.name,
        start: UTILS.jiraDateToLuxonDateTime(x.startDate),
        end: UTILS.jiraDateToLuxonDateTime(x.endDate),
        description: x.goal
      };
    });
  },

  async loadSprints() {
    return await UTILS.loadAllFromPageable(50, this.loadSprintsPageable.bind(this));
  },

  async loadTasksBySprintPageable(id, offset, count) {
    const response = await this.__fetch(`/agile/1.0/sprint/${id}/issue?startAt=${offset}&maxResults=${count}&fields=null`, {
      headers: this.__headers,
      method: 'GET'
    });
    this.__logResponse(response, 'loadTasksBySprint', id, offset, count);
    const rawJson = await response.json();
    return rawJson.issues.map(x => {
      return {
        id: x.id,
        name: x.key
      };
    });
  },

  async loadTasksBySprint(id) {
    return await UTILS.loadAllFromPageable(50, this.loadTasksBySprintPageable.bind(this, id));
  }
};

run().then(() => console.log('end')).catch(e => console.error(e));

async function run() {
  console.log('collect jira sprints');
  const jiraSprints = await JIRA.loadSprints();

  console.log('collect jira tasks');
  const jiraTasksBySprintName = new Map();
  await UTILS.callAsSingleAsync(
    jiraSprints.map(
      jiraSprint => {
        return async () => {
          const tasks = await JIRA.loadTasksBySprint(jiraSprint.id);
          jiraTasksBySprintName.set(jiraSprint.name, tasks);
        };
      }
    )
  );

  console.log('clear youtrack spritns');
  await UTILS.callAsSingleAsync(
    (await YOUTRACK.getAllSprints())
      .map(x => () => YOUTRACK.deleteSprint(x.id))
  );

  console.log('create youtrack sprints');
  await UTILS.callAsSingleAsync(
    jiraSprints.map(
      jiraSprint =>
        () => YOUTRACK.createBoard({
          start: jiraSprint.start.ts,
          finish: jiraSprint.end.ts,
          name: jiraSprint.name,
          description: jiraSprint.description
        })
    )
  );

  console.log('put youtrack tasks to youtrack sprints');
  await UTILS.callAsSingleAsync([...jiraTasksBySprintName.entries()].map(([sprintName, tasks]) =>
    () => {
      return YOUTRACK.addTasksToSprints(tasks.map(x => x.name), sprintName);
    })
  );

  console.log('errors: ', UTILS.collectedErrors);
}