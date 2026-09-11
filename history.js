function goBack() {
  window.history.back();
}
document.addEventListener('DOMContentLoaded', () => {
  const backButton = document.getElementById('backButton');
  
  if (backButton && window.history.length <= 1) {
    backButton.disabled = true;
    backButton.textContent = '🏠 Home Page';
  }
});



const sidebar = document.getElementById('sidebar');
const mainContent = document.getElementById('mainContent');

function toggleSidebar() {
    sidebar.classList.toggle('active');
    if (mainContent) {
        mainContent.classList.toggle('shifted');
    }
}

document.addEventListener('click', (e) => {
    if (sidebar.classList.contains('active') && 
        !sidebar.contains(e.target) && 
        !e.target.closest('.menu-toggle')) {
        toggleSidebar();
    }
});
