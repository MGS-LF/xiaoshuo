const state = {
  projects: [],
  current: null,
  navigationTarget: null,
  selectedChapter: 1,
  outlineTab: 'plot',
  jobs: new Map(),
  continuousProjects: new Set(),
  deriveSource: null,
  replanSource: null,
  outlineWatchers: new Set(),
};

const $ = (selector, root = document) => root.querySelector(selector);
const workspace = $('#workspace');
const projectList = $('#projectList');
const breadcrumb = $('#breadcrumb');
const topActions = $('#topActions');

const chapterJobKey = (projectId, chapterNum) => `chapter:${projectId}:${chapterNum}`;
const outlineJobKey = (projectId) => `outline:${projectId}`;
const replanJobKey = (projectId) => `replan:${projectId}`;
const getChapterJob = (projectId, chapterNum) => state.jobs.get(chapterJobKey(projectId, chapterNum));
const hasProjectJobs = (projectId) => [...state.jobs.values()].some((job) => job.projectId === projectId);

const referenceModeOptions = [
  ['logic', '大体逻辑'],
  ['style', '相似文风'],
  ['expansion', '结构扩充'],
  ['comprehensive', '综合参考'],
];

function referenceFields(excludeId = '', selectedId = '', selectedMode = 'logic') {
  const projects = state.projects.filter((project) => project.id !== excludeId);
  return `<div class="reference-picker full">
    <label>参考作品
      <select name="reference_project_id">
        <option value="">不参考其他作品</option>
        ${projects.map((project) => `<option value="${project.id}" ${project.id === selectedId ? 'selected' : ''}>${escapeHtml(project.title)}</option>`).join('')}
      </select>
    </label>
    <label>参考方式
      <select name="reference_mode">
        ${referenceModeOptions.map(([value, label]) => `<option value="${value}" ${value === selectedMode ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </label>
  </div>`;
}

function bindReferenceFields(root) {
  const projectSelect = root.querySelector('[name="reference_project_id"]');
  const modeSelect = root.querySelector('[name="reference_mode"]');
  if (!projectSelect || !modeSelect) return;
  const sync = () => { modeSelect.disabled = !projectSelect.value; };
  projectSelect.addEventListener('change', sync);
  sync();
}

function icons() {
  if (window.lucide) window.lucide.createIcons();
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  $('#toasts').append(node);
  setTimeout(() => node.remove(), 4000);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

const statuses = {
  draft: '待规划', planning: '规划中', outline_review: '审核大纲', ready: '待写作',
  planning_failed: '规划失败', writing: '写作中', replanning: '重规划中', completed: '已完成',
};

async function loadProjects() {
  state.projects = await api('/api/projects');
  renderProjectList();
}

function renderProjectList() {
  projectList.innerHTML = state.projects.length
    ? state.projects.map((project) => {
      const running = hasProjectJobs(project.id);
      return `
      <div class="project-row">
        <button class="project-item ${state.current?.id === project.id ? 'active' : ''}" data-project="${project.id}">
          <strong>${escapeHtml(project.title)}</strong>
          <small class="${running ? 'running' : ''}">${escapeHtml(project.genre)} · ${running ? '后台生成中' : statuses[project.status] || project.status}</small>
        </button>
        <button class="project-more" data-project-more="${project.id}" title="作品操作"><i data-lucide="ellipsis"></i></button>
        <div class="project-menu" data-project-menu="${project.id}">
          <button data-delete-project="${project.id}"><i data-lucide="trash-2"></i>删除</button>
        </div>
      </div>`;
    }).join('')
    : '<div class="sidebar-label">暂无作品</div>';
  projectList.querySelectorAll('[data-project]').forEach((button) => {
    button.onclick = () => openProject(button.dataset.project);
  });
  projectList.querySelectorAll('[data-project-more]').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      const menu = projectList.querySelector(`[data-project-menu="${button.dataset.projectMore}"]`);
      projectList.querySelectorAll('.project-menu.open').forEach((item) => {
        if (item !== menu) item.classList.remove('open');
      });
      menu.classList.toggle('open');
    };
  });
  projectList.querySelectorAll('[data-delete-project]').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      deleteProject(button.dataset.deleteProject);
    };
  });
  icons();
}

async function deleteProject(id) {
  const project = state.projects.find((item) => item.id === id);
  if (!project) return;
  if (hasProjectJobs(id)) {
    return toast('该作品有后台任务正在执行，暂时不能删除', 'error');
  }
  if (!window.confirm(`确定删除《${project.title}》？大纲和全部章节将一并删除。`)) return;
  try {
    await api(`/api/projects/${id}`, { method: 'DELETE' });
    state.projects = state.projects.filter((item) => item.id !== id);
    if (state.current?.id === id) newProject();
    else renderProjectList();
    toast('作品已删除');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function openProject(id) {
  state.navigationTarget = id;
  try {
    const project = await api(`/api/projects/${id}`);
    if (state.navigationTarget !== id) return;
    state.current = project;
    state.selectedChapter = Math.max(1, state.current.chapters.find((item) => item.status !== 'done')?.chapter_num || 1);
    renderProjectList();
    render();
    $('#sidebar').classList.remove('open');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function newProject() {
  state.navigationTarget = null;
  state.current = null;
  renderProjectList();
  renderCreate();
  $('#sidebar').classList.remove('open');
}

function render() {
  if (!state.current) return renderCreate();
  breadcrumb.textContent = `作品 / ${state.current.title}`;
  const exportAction = state.current.chapters?.some((chapter) => chapter.content)
    ? `<a class="btn secondary" href="/api/projects/${state.current.id}/export"><i data-lucide="download"></i><span class="action-label">导出</span></a>` : '';
  topActions.innerHTML = `<button class="btn secondary" id="deriveProject"><i data-lucide="copy-plus"></i><span class="action-label">衍生创作</span></button>${exportAction}`;
  $('#deriveProject').onclick = openDeriveDialog;
  if (['draft', 'planning', 'planning_failed'].includes(state.current.status)) return renderPlanning();
  if (state.current.status === 'outline_review') return renderOutline();
  return renderStudio();
}

function renderCreate() {
  breadcrumb.textContent = '创作台 / 新建';
  topActions.innerHTML = '';
  workspace.innerHTML = `
    <section class="welcome">
      <div class="eyebrow">New story</div>
      <h1>从一个命题，推演一部长篇</h1>
      <p>设定故事边界，模型将规划世界、人物、时间线和逐章剧情。大纲确认后进入连续写作。</p>
      <form class="create-panel" id="createForm">
        <div class="form-grid">
          <label>书名<input name="title" required maxlength="80" placeholder="暂定书名"></label>
          <label>类型
            <select name="genre" required>
              <option value="玄幻">玄幻</option><option value="都市">都市</option><option value="科幻">科幻</option>
              <option value="悬疑">悬疑</option><option value="言情">言情</option><option value="历史">历史</option>
              <option value="武侠">武侠</option><option value="奇幻">奇幻</option><option value="现实">现实</option>
            </select>
          </label>
          <label class="full">主题<input name="theme" required maxlength="300" placeholder="例如：失忆调查员发现每个梦境都对应一桩未发生的案件"></label>
          <label>章节数<input name="chapter_count" type="number" required min="1" max="1000" value="20"></label>
          <label>每章字数<input name="words_per_chapter" type="number" required min="500" max="10000" step="100" value="2000"></label>
          <label class="full">文风<input name="style" placeholder="例如：冷峻克制，多用短句"></label>
          ${referenceFields()}
          <label class="full">自定义设定（可选）
            <textarea name="extra_prompt" class="custom-setting-input" maxlength="10000" placeholder="可预设人物姓名、身份、性格、关系、世界规则、关键情节或禁用内容。&#10;例如：主角叫林默，22岁，法医专业；女主苏遥是他的青梅竹马，两人开篇处于冷战状态。人物姓名和关系不得修改。"></textarea>
            <span class="field-help">模型规划大纲和撰写正文时会优先遵守这里的内容</span>
          </label>
        </div>
        <div class="form-footer">
          <span class="hint">创建后再调用模型规划大纲</span>
          <button class="btn dark" type="submit">创建作品<i data-lucide="arrow-right"></i></button>
        </div>
      </form>
    </section>`;
  $('#createForm').onsubmit = createProject;
  bindReferenceFields($('#createForm'));
  icons();
}

async function createProject(event) {
  event.preventDefault();
  const button = event.submitter;
  const navigationToken = `new:${Date.now()}`;
  state.navigationTarget = navigationToken;
  button.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(event.currentTarget));
    body.chapter_count = Number(body.chapter_count);
    body.words_per_chapter = Number(body.words_per_chapter);
    const project = await api('/api/projects', { method: 'POST', body: JSON.stringify(body) });
    await loadProjects();
    if (state.navigationTarget === navigationToken) {
      state.navigationTarget = project.id;
      state.current = project;
      render();
    }
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
  }
}

function projectHead() {
  const project = state.current;
  return `<div class="page-head">
    <div class="page-title"><h1>${escapeHtml(project.title)}</h1><p>${escapeHtml(project.genre)} · ${escapeHtml(project.theme)} · ${project.chapter_count} 章</p></div>
    <span class="status-pill ${project.status}"><i></i>${statuses[project.status] || project.status}</span>
  </div>`;
}

function renderPlanning() {
  const project = state.current;
  const loading = project.status === 'planning';
  const failed = project.status === 'planning_failed';
  const job = project.generation_job;
  const total = Math.max(1, Number(job?.total_batches || 1));
  const completed = Math.min(total, Number(job?.completed_batches || 0));
  const percent = Math.round(completed / total * 100);
  workspace.innerHTML = `${projectHead()}
    <section class="empty-stage">
      <div class="stage-icon">${loading ? '<span class="loader"></span>' : `<i data-lucide="${failed ? 'triangle-alert' : 'network'}"></i>`}</div>
      <h2>${loading ? '正在推演故事结构' : failed ? '当前批次规划失败' : '生成全书大纲'}</h2>
      <p>${loading ? '模型正在按批次组织世界观、人物弧光、时间线与逐章剧情。' : failed ? '已完成的批次保存在 SQLite，重试会从失败批次继续。' : '大纲会按世界设定、主要人物、时间线、大体剧情和章节规划分块展示，确认后才开始写作。'}</p>
      ${(loading || failed) && job ? `<div class="planning-progress">
        <div class="planning-progress-head"><strong>${failed ? `第 ${job.current_batch} 批失败` : `正在处理第 ${job.current_batch} / ${total} 批`}</strong><span>${completed} / ${total} · ${percent}%</span></div>
        <div class="progress-line"><b style="width:${percent}%"></b></div>
        ${job.error ? `<p class="planning-error">${escapeHtml(job.error)}</p>` : ''}
      </div>` : ''}
      <div class="custom-brief">
        <label>自定义设定（可选）
          <textarea id="planningCustomSetting" maxlength="10000" ${loading || failed ? 'readonly' : ''} placeholder="预设人物、人物关系、世界规则、关键情节或其他必须遵守的内容">${escapeHtml(project.extra_prompt || '')}</textarea>
          <span class="field-help">预设人物的姓名、身份和关系会作为大纲的硬性约束</span>
        </label>
        ${referenceFields(project.id, project.reference_project_id, project.reference_mode || 'logic')}
      </div>
      <button class="btn primary" id="generateOutline" ${loading ? 'disabled' : ''}>${loading ? '<span class="loader"></span>后台规划中' : failed ? '<i data-lucide="refresh-cw"></i>重试失败批次' : '<i data-lucide="sparkles"></i>生成大纲'}</button>
    </section>`;
  if (!loading) $('#generateOutline').onclick = failed ? retryOutlineBatch : generateOutlineAction;
  bindReferenceFields(workspace);
  if (loading || failed) {
    $$('.custom-brief select').forEach((select) => { select.disabled = true; });
  }
  if (loading) void watchOutlineJob(project.id);
  icons();
}

async function generateOutlineAction() {
  const projectId = state.current.id;
  const jobKey = outlineJobKey(projectId);
  state.jobs.set(jobKey, { projectId, type: 'outline', status: 'planning' });
  renderProjectList();
  let started = false;
  try {
    const extraPrompt = $('#planningCustomSetting')?.value.trim() || '';
    const referenceProjectId = $('[name="reference_project_id"]', workspace)?.value || '';
    const referenceMode = $('[name="reference_mode"]', workspace)?.value || '';
    const updated = await api(`/api/projects/${projectId}`, {
      method: 'PATCH', body: JSON.stringify({
        extra_prompt: extraPrompt,
        reference_project_id: referenceProjectId,
        reference_mode: referenceMode,
      }),
    });
    if (state.current?.id === projectId) {
      state.current = updated;
      state.current.status = 'planning';
      renderPlanning();
    }
    const job = await api(`/api/projects/${projectId}/outline/generate`, { method: 'POST' });
    started = true;
    if (state.current?.id === projectId) {
      state.current.status = 'planning';
      state.current.generation_job = job;
      renderPlanning();
    }
    void watchOutlineJob(projectId);
  } catch (error) {
    if (state.current?.id === projectId) {
      state.current.status = 'draft';
      renderPlanning();
    }
    toast(error.message, 'error');
  } finally {
    if (!started) {
      state.jobs.delete(jobKey);
      renderProjectList();
    }
  }
}

async function retryOutlineBatch() {
  const projectId = state.current.id;
  const key = outlineJobKey(projectId);
  state.jobs.set(key, { projectId, type: 'outline', status: 'planning' });
  renderProjectList();
  try {
    const job = await api(`/api/projects/${projectId}/outline/retry`, { method: 'POST' });
    if (state.current?.id === projectId) {
      state.current.status = 'planning';
      state.current.generation_job = job;
      renderPlanning();
    }
    void watchOutlineJob(projectId);
  } catch (error) {
    state.jobs.delete(key);
    renderProjectList();
    toast(error.message, 'error');
  }
}

async function watchOutlineJob(projectId) {
  if (state.outlineWatchers.has(projectId)) return;
  state.outlineWatchers.add(projectId);
  state.jobs.set(outlineJobKey(projectId), { projectId, type: 'outline', status: 'planning' });
  renderProjectList();
  try {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const project = await api(`/api/projects/${projectId}`);
      if (state.current?.id === projectId) {
        state.current = project;
        render();
      }
      if (project.status !== 'planning') {
        if (project.status === 'outline_review') toast('全书大纲规划完成');
        break;
      }
    }
  } catch (error) {
    toast(`读取规划进度失败：${error.message}`, 'error');
  } finally {
    state.outlineWatchers.delete(projectId);
    state.jobs.delete(outlineJobKey(projectId));
    await loadProjects().catch(() => {});
    if (state.current?.id === projectId) render();
  }
}

function field(path, value, multiline = true, label = '') {
  const control = multiline
    ? `<textarea data-path="${path}">${escapeHtml(value)}</textarea>`
    : `<input data-path="${path}" value="${escapeHtml(value)}">`;
  return `<label>${label}${control}</label>`;
}

function renderOutline() {
  const p = state.current;
  const outline = p.outline || {};
  const world = outline.world || p.world || {};
  const plot = outline.plot || p.plot || {};
  const characters = outline.characters || p.characters || [];
  const timeline = outline.timeline || p.timeline || [];
  const chapters = outline.chapters || [];
  const tabs = [
    ['plot', '大体剧情'], ['characters', '主要人物'], ['world', '世界设定'],
    ['timeline', '时间线'], ['chapters', `章节大纲 · ${chapters.length}`],
  ];
  workspace.innerHTML = `${projectHead()}<div class="outline-shell">
    <nav class="outline-nav">${tabs.map(([id, name]) => `<button class="outline-tab ${state.outlineTab === id ? 'active' : ''}" data-tab="${id}">${name}</button>`).join('')}</nav>
    <section class="outline-section ${state.outlineTab === 'plot' ? 'active' : ''}" data-section="plot">
      <div class="section-heading"><h2>大体剧情</h2><span>核心冲突与全书走向</span></div>
      <div class="outline-grid">
        <div class="outline-card">${field('plot.premise', plot.premise, true, '核心卖点')}${field('plot.conflict', plot.conflict, true, '主要冲突')}</div>
        <div class="outline-card">${field('plot.structure', plot.structure, true, '结构节奏')}${field('plot.ending_direction', plot.ending_direction, true, '结局方向')}</div>
        <div class="outline-card full">${field('plot.hooks', (plot.hooks || []).join('\n'), true, '伏笔（每行一条）')}</div>
      </div>
    </section>
    <section class="outline-section ${state.outlineTab === 'characters' ? 'active' : ''}" data-section="characters">
      <div class="section-heading"><h2>主要人物</h2><span>${characters.length} 位角色</span></div>
      <div class="outline-grid">${characters.map((c, i) => `<div class="outline-card"><h3>${escapeHtml(c.name || `角色 ${i + 1}`)}</h3><div class="mini-grid">${field(`characters.${i}.name`, c.name, false, '姓名')}${field(`characters.${i}.role`, c.role, false, '定位')}</div>${field(`characters.${i}.personality`, c.personality, true, '性格')}${field(`characters.${i}.goal`, c.goal, true, '目标')}${field(`characters.${i}.background`, c.background, true, '背景')}${field(`characters.${i}.arc`, c.arc, true, '人物弧光')}</div>`).join('')}</div>
    </section>
    <section class="outline-section ${state.outlineTab === 'world' ? 'active' : ''}" data-section="world">
      <div class="section-heading"><h2>世界设定</h2><span>故事运行的边界条件</span></div>
      <div class="outline-grid"><div class="outline-card">${field('world.setting', world.setting, true, '时代与背景')}${field('world.tone', world.tone, true, '叙事基调')}</div><div class="outline-card">${field('world.rules', world.rules, true, '世界规则')}${field('world.locations_text', (world.locations || []).map((l) => typeof l === 'string' ? l : `${l.name}：${l.desc || ''}`).join('\n'), true, '重要地点（每行一处）')}</div></div>
    </section>
    <section class="outline-section ${state.outlineTab === 'timeline' ? 'active' : ''}" data-section="timeline">
      <div class="section-heading"><h2>时间线</h2><span>全书事件顺序</span></div>
      <div class="outline-grid">${timeline.map((item, i) => `<div class="outline-card"><h3>${escapeHtml(item.time || `阶段 ${i + 1}`)}</h3><div class="mini-grid">${field(`timeline.${i}.time`, item.time, false, '时间点')}${field(`timeline.${i}.chapter_range`, item.chapter_range, false, '覆盖章节')}</div>${field(`timeline.${i}.event`, item.event, true, '事件')}</div>`).join('')}</div>
    </section>
    <section class="outline-section ${state.outlineTab === 'chapters' ? 'active' : ''}" data-section="chapters">
      <div class="section-heading"><h2>章节大纲</h2><span>逐章因果、关键事件与章末钩子</span></div>
      <div class="outline-grid">${chapters.map((c, i) => `<div class="outline-card chapter-outline"><span class="chapter-number">${String(i + 1).padStart(2, '0')}</span>${field(`chapters.${i}.title`, c.title, false, '章名')}${field(`chapters.${i}.summary`, c.summary, true, '本章剧情')}${field(`chapters.${i}.key_events`, (c.key_events || []).join('\n'), true, '关键事件（每行一条）')}${field(`chapters.${i}.ending_hook`, c.ending_hook, true, '章末钩子')}</div>`).join('')}</div>
    </section>
    <div class="sticky-confirm"><span>修改会先保存到 SQLite，确认后锁定全书框架并开放正文生成。</span><div><button class="btn secondary" id="saveOutline">保存修改</button> <button class="btn primary" id="confirmOutline"><i data-lucide="check"></i>确认大纲</button></div></div>
  </div>`;

  $$('.outline-tab').forEach((tab) => tab.onclick = () => {
    collectOutline();
    state.outlineTab = tab.dataset.tab;
    renderOutline();
  });
  $('#saveOutline').onclick = saveOutline;
  $('#confirmOutline').onclick = confirmOutline;
  icons();
}

function $$(selector, root = document) { return [...root.querySelectorAll(selector)]; }

function setPath(object, path, value) {
  const parts = path.split('.');
  let cursor = object;
  for (let i = 0; i < parts.length - 1; i++) cursor = cursor[parts[i]];
  cursor[parts.at(-1)] = value;
}

function collectOutline() {
  const outline = state.current.outline;
  $$('[data-path]').forEach((input) => {
    const path = input.dataset.path;
    let value = input.value.trim();
    if (path.endsWith('.hooks') || path.endsWith('.key_events')) value = value.split('\n').map((v) => v.trim()).filter(Boolean);
    if (path === 'world.locations_text') {
      outline.world.locations = value.split('\n').map((line) => {
        const [name, ...desc] = line.split(/[：:]/);
        return { name: name.trim(), desc: desc.join('：').trim() };
      }).filter((item) => item.name);
      return;
    }
    setPath(outline, path, value);
  });
}

async function saveOutline(silent = false) {
  const projectId = state.current.id;
  collectOutline();
  const payload = JSON.stringify(state.current.outline);
  try {
    const result = await api(`/api/projects/${projectId}/outline`, {
      method: 'PUT', body: payload,
    });
    if (state.current?.id === projectId) state.current = result;
    if (!silent) toast('大纲已保存');
    return result;
  } catch (error) {
    toast(error.message, 'error');
    return false;
  }
}

async function confirmOutline() {
  const projectId = state.current.id;
  const button = $('#confirmOutline');
  button.disabled = true;
  if (!await saveOutline(true)) { button.disabled = false; return; }
  try {
    const result = await api(`/api/projects/${projectId}/outline/confirm`, { method: 'POST' });
    if (state.current?.id === projectId) state.current = result;
    await loadProjects();
    if (state.current?.id === projectId) renderStudio();
    toast('大纲已确认，写作台已开启');
  } catch (error) {
    button.disabled = false;
    toast(error.message, 'error');
  }
}

function renderStudio(preserveScroll = false) {
  const previousScroll = preserveScroll ? $('#chapterContent')?.scrollTop : null;
  const p = state.current;
  const chapters = p.chapters || [];
  let current = chapters.find((c) => c.chapter_num === state.selectedChapter) || chapters[0];
  if (!current) return renderPlanning();
  state.selectedChapter = current.chapter_num;
  const done = chapters.filter((c) => c.status === 'done').length;
  const percent = Math.round(done / p.chapter_count * 100);
  const job = getChapterJob(p.id, current.chapter_num);
  const effectiveStatus = job?.status || current.status;
  const currentContent = job?.content ?? current.content ?? '';
  const projectReplanning = state.jobs.has(replanJobKey(p.id)) || p.status === 'replanning';
  const busy = Boolean(job) || projectReplanning || ['writing', 'summarizing'].includes(effectiveStatus);
  const locked = effectiveStatus === 'done';
  const continuous = state.continuousProjects.has(p.id);
  const generateLabel = effectiveStatus === 'generated'
    ? '<i data-lucide="refresh-cw"></i>重新整理记忆'
    : '<i data-lucide="pen-line"></i>生成本章';
  workspace.innerHTML = `${projectHead()}<div class="studio">
    <aside class="chapter-rail">
      <div class="rail-head"><strong>章节</strong><span>${done}/${p.chapter_count}</span></div>
      ${chapters.map((ch) => {
        const status = getChapterJob(p.id, ch.chapter_num)?.status || ch.status;
        return `<button class="chapter-link ${ch.chapter_num === current.chapter_num ? 'active' : ''} ${status}" data-chapter="${ch.chapter_num}"><span class="num">${String(ch.chapter_num).padStart(2, '0')}</span><span class="chapter-name">${escapeHtml(ch.title)}</span><i data-lucide="${status === 'done' ? 'circle-check' : ['writing', 'summarizing'].includes(status) ? 'loader-circle' : 'circle'}"></i></button>`;
      }).join('')}
    </aside>
    <section class="editor">
      <div class="progress-line"><b style="width:${percent}%"></b></div>
      <div class="editor-head"><span class="chapter-index">第 ${current.chapter_num} 章</span><input id="chapterTitle" value="${escapeHtml(current.title)}" ${busy || locked ? 'disabled' : ''}></div>
      <div class="editor-meta"><span id="chapterStatus">${escapeHtml(statuses[effectiveStatus] || ({pending:'待生成', done:'已完成', generated:'待总结', summarizing:'整理记忆中'}[effectiveStatus] || effectiveStatus))}</span><span id="wordCount">${currentContent.replace(/\s/g, '').length} 字</span><span>全局记忆 ${p.global_summary ? '已更新' : '待建立'}</span></div>
      <div class="outline-strip"><strong>本章目标：</strong>${escapeHtml(current.outline || '暂无章节大纲')}</div>
      <textarea class="novel-editor" id="chapterContent" placeholder="正文将在这里流式生成，也可以手动编辑。" ${busy || locked ? 'readonly' : ''}>${escapeHtml(currentContent)}</textarea>
      <div class="editor-actions">
        <button class="btn primary" id="generateChapter" ${locked || busy ? 'disabled' : ''}>${busy ? `<span class="loader"></span>${projectReplanning ? '重规划中' : '生成中'}` : generateLabel}</button>
        <button class="btn secondary" id="saveChapter" ${busy || locked ? 'disabled' : ''}><i data-lucide="save"></i>保存正文</button>
        <button class="btn secondary" id="replanContinuation" ${projectReplanning || hasProjectJobs(p.id) ? 'disabled' : ''}><i data-lucide="git-branch"></i>重规划后续</button>
        <button class="btn dark" id="continuousWrite" ${done === p.chapter_count || (busy && !continuous) ? 'disabled' : ''}><i data-lucide="fast-forward"></i>${continuous ? '当前章后停止' : '连续写作'}</button>
      </div>
      <details class="memory-panel"><summary>章节摘要与上下文记忆</summary><p>${escapeHtml(current.summary || '本章完成后自动生成摘要，并压缩进入全局记忆。')}</p></details>
    </section>
  </div>`;

  $$('.chapter-link').forEach((button) => button.onclick = () => {
    state.selectedChapter = Number(button.dataset.chapter);
    renderStudio();
  });
  $('#chapterContent').oninput = (event) => $('#wordCount').textContent = `${event.target.value.replace(/\s/g, '').length} 字`;
  $('#saveChapter').onclick = saveChapter;
  $('#generateChapter').onclick = () => effectiveStatus === 'generated'
    ? finalizeChapter(p.id, current.chapter_num)
    : generateOne(p.id, current.chapter_num);
  $('#continuousWrite').onclick = () => continuousWrite(p.id);
  $('#replanContinuation').onclick = openReplanDialog;
  if (previousScroll != null) $('#chapterContent').scrollTop = previousScroll;
  icons();
}

async function finalizeChapter(projectId, num) {
  const key = chapterJobKey(projectId, num);
  if (state.jobs.has(key)) return null;
  let project = state.current?.id === projectId ? state.current : await api(`/api/projects/${projectId}`);
  const chapter = project.chapters.find((item) => item.chapter_num === num);
  const job = { projectId, chapterNum: num, type: 'chapter', status: 'summarizing', content: chapter.content || '' };
  state.jobs.set(key, job);
  renderProjectList();
  chapter.status = 'summarizing';
  if (state.current?.id === projectId) renderStudio(true);
  try {
    await api(`/api/projects/${projectId}/chapters/${num}/finalize`, { method: 'POST' });
    project = await api(`/api/projects/${projectId}`);
    if (state.current?.id === projectId) state.current = project;
    toast(`第 ${num} 章记忆已重新整理`);
  } catch (error) {
    project = await api(`/api/projects/${projectId}`).catch(() => project);
    if (state.current?.id === projectId) state.current = project;
    toast(error.message, 'error');
  } finally {
    state.jobs.delete(key);
    await loadProjects().catch(() => {});
    if (state.current?.id === projectId) renderStudio(true);
  }
  return project;
}

async function saveChapter() {
  const chapter = state.current.chapters.find((item) => item.chapter_num === state.selectedChapter);
  try {
    const saved = await api(`/api/projects/${state.current.id}/chapters/${chapter.chapter_num}`, {
      method: 'PUT',
      body: JSON.stringify({ title: $('#chapterTitle').value.trim(), content: $('#chapterContent').value }),
    });
    Object.assign(chapter, saved);
    toast('章节已保存');
  } catch (error) { toast(error.message, 'error'); }
}

async function readEventStream(response, handlers) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      let event = 'message';
      let data = null;
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) data = JSON.parse(line.slice(5).trim());
      }
      if (data && handlers[event]) handlers[event](data);
    }
  }
}

function updateVisibleStream(job) {
  if (state.current?.id !== job.projectId || state.selectedChapter !== job.chapterNum) return;
  const editor = $('#chapterContent');
  const counter = $('#wordCount');
  if (!editor || !counter) return;
  const previousTop = editor.scrollTop;
  const wasNearBottom = editor.scrollHeight - editor.scrollTop - editor.clientHeight < 80;
  editor.value = job.content;
  counter.textContent = `${job.content.replace(/\s/g, '').length} 字`;
  editor.scrollTop = wasNearBottom ? editor.scrollHeight : previousTop;
}

async function generateOne(projectId, num) {
  const key = chapterJobKey(projectId, num);
  if (state.jobs.has(key)) return null;
  let project = state.current?.id === projectId ? state.current : await api(`/api/projects/${projectId}`);
  const chapter = project.chapters.find((item) => item.chapter_num === num);
  if (!chapter) return null;
  const job = { projectId, chapterNum: num, type: 'chapter', status: 'writing', content: '' };
  state.jobs.set(key, job);
  renderProjectList();
  chapter.status = 'writing';
  chapter.content = '';
  if (state.current?.id === projectId) renderStudio(true);
  try {
    const response = await fetch(`/api/projects/${projectId}/chapters/${num}/generate`, { method: 'POST' });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || '生成失败');
    }
    await readEventStream(response, {
      delta: ({ text }) => {
        job.content += text;
        chapter.content = job.content;
        updateVisibleStream(job);
      },
      phase: ({ phase }) => {
        job.status = phase;
        chapter.status = phase;
        if (state.current?.id === projectId && state.selectedChapter === num) {
          const button = $('#generateChapter');
          const status = $('#chapterStatus');
          if (phase === 'summarizing' && button) button.innerHTML = '<span class="loader"></span>整理记忆';
          if (status) status.textContent = phase === 'summarizing' ? '整理记忆中' : '写作中';
        }
      },
      done: ({ chapter: saved }) => {
        job.status = 'done';
        Object.assign(chapter, saved);
      },
      error: ({ error }) => { throw new Error(error); },
    });
    project = await api(`/api/projects/${projectId}`);
    if (state.current?.id === projectId) state.current = project;
    toast(`第 ${num} 章已完成并写入记忆`);
  } catch (error) {
    toast(error.message, 'error');
    project = await api(`/api/projects/${projectId}`).catch(() => project);
    if (state.current?.id === projectId) state.current = project;
  } finally {
    state.jobs.delete(key);
    await loadProjects().catch(() => {});
    if (state.current?.id === projectId) renderStudio(true);
  }
  return project;
}

async function continuousWrite(projectId) {
  if (state.continuousProjects.has(projectId)) {
    state.continuousProjects.delete(projectId);
    toast('将在当前章节完成后停止');
    if (state.current?.id === projectId) renderStudio(true);
    return;
  }
  state.continuousProjects.add(projectId);
  if (state.current?.id === projectId) renderStudio(true);
  let project = state.current?.id === projectId ? state.current : await api(`/api/projects/${projectId}`);
  while (state.continuousProjects.has(projectId)) {
    const next = project.chapters.find((chapter) => chapter.status !== 'done');
    if (!next) break;
    project = next.status === 'generated'
      ? await finalizeChapter(projectId, next.chapter_num)
      : await generateOne(projectId, next.chapter_num);
    if (!project?.chapters.find((chapter) => chapter.chapter_num === next.chapter_num && chapter.status === 'done')) break;
  }
  state.continuousProjects.delete(projectId);
  if (state.current?.id === projectId) renderStudio(true);
}

function applyDeriveMode(resetDefaults = false) {
  const form = $('#deriveForm');
  const source = state.deriveSource;
  if (!source) return;
  const mode = form.elements.mode.value;
  const sequel = mode === 'sequel';
  $('#deriveModeNote').textContent = sequel
    ? '继承原作人物、世界设定、全局摘要和最近结尾，再规划新的冲突与章节。'
    : '复用类型、篇幅、文风和自定义设定，不携带原作剧情与章节正文。';
  if (resetDefaults) {
    form.elements.title.value = sequel ? `${source.title}·续篇` : `${source.title}·新作`;
    form.elements.theme.value = sequel ? `承接《${source.title}》结局，展开新的故事` : source.theme;
  }
}

function openDeriveDialog() {
  const source = state.current;
  if (!source) return;
  state.deriveSource = source;
  const form = $('#deriveForm');
  const hasStory = Boolean(source.global_summary || source.chapters?.some((chapter) => chapter.content));
  form.elements.mode.value = hasStory ? 'sequel' : 'template';
  form.elements.genre.value = source.genre;
  form.elements.chapter_count.value = source.chapter_count;
  form.elements.words_per_chapter.value = source.words_per_chapter;
  form.elements.style.value = source.style || '';
  form.elements.extra_prompt.value = source.extra_prompt || '';
  $('#deriveSourceLabel').textContent = `基于《${source.title}》创建独立新作品`;
  applyDeriveMode(true);
  $('#deriveDialog').showModal();
  icons();
}

$('#deriveForm').querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.onchange = () => applyDeriveMode(true);
});

$('#deriveForm').onsubmit = async (event) => {
  event.preventDefault();
  const source = state.deriveSource;
  if (!source) return;
  const button = event.submitter || $('#deriveForm button[type="submit"]');
  button.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(event.currentTarget));
    body.chapter_count = Number(body.chapter_count);
    body.words_per_chapter = Number(body.words_per_chapter);
    const project = await api(`/api/projects/${source.id}/derive`, {
      method: 'POST', body: JSON.stringify(body),
    });
    state.navigationTarget = project.id;
    state.current = project;
    state.selectedChapter = 1;
    $('#deriveDialog').close();
    await loadProjects();
    render();
    toast(body.mode === 'sequel' ? '续作草稿已创建' : '模板新作已创建');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
};

$('#cancelDerive').onclick = () => $('#deriveDialog').close();
$('#closeDerive').onclick = () => $('#deriveDialog').close();
$('#closeSettings').onclick = () => $('#settingsDialog').close();

function updateReplanWarning() {
  const form = $('#replanForm');
  const source = state.replanSource;
  if (!source) return;
  const start = Number(form.elements.start_chapter.value);
  form.elements.chapter_count.min = String(start);
  if (Number(form.elements.chapter_count.value) < start) {
    form.elements.chapter_count.value = String(start);
  }
  const completed = source.chapters.filter(
    (chapter) => chapter.chapter_num >= start && chapter.status === 'done'
  ).length;
  $('#replanWarning').textContent = completed
    ? `第 ${start} 章及之后的大纲、正文和记忆会被替换，其中包含 ${completed} 个已完成章节；此前章节保持不变。`
    : `第 ${start} 章及之后的章节标题和大纲会被替换；此前章节保持不变。`;
}

function openReplanDialog() {
  const source = state.current;
  if (!source?.chapters?.length) return;
  state.replanSource = source;
  const form = $('#replanForm');
  form.elements.start_chapter.innerHTML = source.chapters.map((chapter) =>
    `<option value="${chapter.chapter_num}" ${chapter.chapter_num === state.selectedChapter ? 'selected' : ''}>第 ${chapter.chapter_num} 章 · ${escapeHtml(chapter.title)}</option>`
  ).join('');
  form.elements.chapter_count.value = source.chapter_count;
  form.elements.instruction.value = '';
  $('#replanProjectLabel').textContent = `仅修改《${source.title}》指定章节之后的内容`;
  updateReplanWarning();
  $('#replanDialog').showModal();
  icons();
}

$('#replanForm').elements.start_chapter.onchange = updateReplanWarning;
$('#cancelReplan').onclick = () => $('#replanDialog').close();
$('#closeReplan').onclick = () => $('#replanDialog').close();

$('#replanForm').onsubmit = async (event) => {
  event.preventDefault();
  const source = state.replanSource;
  if (!source) return;
  const form = event.currentTarget;
  const button = event.submitter || form.querySelector('button[type="submit"]');
  const body = {
    start_chapter: Number(form.elements.start_chapter.value),
    chapter_count: Number(form.elements.chapter_count.value),
    instruction: form.elements.instruction.value.trim(),
  };
  const key = replanJobKey(source.id);
  state.jobs.set(key, { projectId: source.id, type: 'replan', status: 'replanning' });
  renderProjectList();
  button.disabled = true;
  $('#replanDialog').close();
  if (state.current?.id === source.id) {
    state.current.status = 'replanning';
    renderStudio(true);
  }
  try {
    const project = await api(`/api/projects/${source.id}/outline/regenerate`, {
      method: 'POST', body: JSON.stringify(body),
    });
    if (state.current?.id === source.id) {
      state.current = project;
      state.selectedChapter = Math.min(body.start_chapter, project.chapter_count);
    }
    toast(`已从第 ${body.start_chapter} 章重新规划后续`);
  } catch (error) {
    const project = await api(`/api/projects/${source.id}`).catch(() => null);
    if (project && state.current?.id === source.id) state.current = project;
    toast(error.message, 'error');
  } finally {
    state.jobs.delete(key);
    button.disabled = false;
    await loadProjects().catch(() => {});
    if (state.current?.id === source.id) render();
  }
};

async function openSettings() {
  try {
    const settings = await api('/api/settings');
    const form = $('#settingsForm');
    for (const key of ['base_url', 'model', 'temperature', 'max_tokens']) form.elements[key].value = settings[key];
    form.elements.api_key.value = '';
    form.elements.api_key.placeholder = settings.has_api_key ? '已保存，留空不修改' : 'sk-...';
    $('#settingsDialog').showModal();
  } catch (error) { toast(error.message, 'error'); }
}

$('#settingsForm').onsubmit = async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    $('#settingsDialog').close();
    $('#modelDot').classList.add('ready');
    toast('模型配置已保存');
  } catch (error) { toast(error.message, 'error'); }
};

$('#testModel').onclick = async () => {
  const button = $('#testModel');
  const form = $('#settingsForm');
  button.disabled = true;
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    const result = await api('/api/settings/test', { method: 'POST' });
    toast(result.reply || '连接成功');
    $('#modelDot').classList.add('ready');
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; }
};

$('#newProject').onclick = newProject;
$('#openSettings').onclick = openSettings;
$('#openSidebar').onclick = () => $('#sidebar').classList.add('open');
$('#closeSidebar').onclick = () => $('#sidebar').classList.remove('open');
document.addEventListener('click', () => {
  projectList.querySelectorAll('.project-menu.open').forEach((menu) => menu.classList.remove('open'));
});

async function boot() {
  try {
    const [projects, settings] = await Promise.all([api('/api/projects'), api('/api/settings')]);
    state.projects = projects;
    $('#modelDot').classList.toggle('ready', settings.has_api_key || settings.base_url.includes('localhost'));
    renderProjectList();
    renderCreate();
  } catch (error) {
    workspace.innerHTML = `<section class="empty-stage"><h2>服务连接失败</h2><p>${escapeHtml(error.message)}</p></section>`;
  }
  icons();
}

boot();
