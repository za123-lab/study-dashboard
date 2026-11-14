export default defineAppConfig({
  pages: [
    'pages/study/index',
    'pages/todo/index',
    'pages/calendar/index',
    'pages/courses/index',
    'pages/settings/index',
  ],
  window: {
    backgroundTextStyle: 'dark',
    backgroundColor: '#f6f1e5',
    navigationBarBackgroundColor: '#f6f1e5',
    navigationBarTitleText: '今日一页',
    navigationBarTextStyle: 'black',
  },
  tabBar: {
    color: '#5a6b7f',
    selectedColor: '#c0453a',
    backgroundColor: '#fbf8f0',
    borderStyle: 'white',
    list: [
      {
        pagePath: 'pages/study/index',
        text: '学习',
        iconPath: 'assets/tabbar/study.png',
        selectedIconPath: 'assets/tabbar/study-on.png',
      },
      {
        pagePath: 'pages/todo/index',
        text: '待办',
        iconPath: 'assets/tabbar/todo.png',
        selectedIconPath: 'assets/tabbar/todo-on.png',
      },
      {
        pagePath: 'pages/calendar/index',
        text: '日历',
        iconPath: 'assets/tabbar/calendar.png',
        selectedIconPath: 'assets/tabbar/calendar-on.png',
      },
      {
        pagePath: 'pages/courses/index',
        text: '课程',
        iconPath: 'assets/tabbar/courses.png',
        selectedIconPath: 'assets/tabbar/courses-on.png',
      },
    ],
  },
})
